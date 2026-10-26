import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { route, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { ArchiveError } from "@/lib/archive/paths";
import { processArchive } from "@/lib/archive/process";
import { diffManifests } from "@/lib/manifest";
import { buildArchive, buildRelease, parseDeleteList } from "@/lib/release";
import { getSettings } from "@/lib/settings";
import { archiveKey, storage } from "@/lib/storage";
import { cleanVersion, currentVersion, getManifest, isUniqueViolation } from "@/lib/versions";

export const runtime = "nodejs";
export const maxDuration = 3600;

const query = z.object({
  version: z.string(),
  channel: z.enum(["STABLE", "BETA"]).default("STABLE"),
  minRole: z.enum(["MEMBER", "VIP", "DEVELOPER", "ADMIN"]).optional(),
  /** full : l'archive est la base complète ; patch : uniquement les fichiers modifiés, fusionnés sur `parent`. */
  mode: z.enum(["full", "patch"]).default("full"),
  /** Version de base (par défaut : la version courante du canal). */
  parent: z.string().max(40).optional(),
  /** Fichiers / dossiers / motifs à supprimer (un par ligne) — patch uniquement. Complète fbm-delete.txt. */
  deletes: z.string().max(8000).optional(),
  stripRoot: z.enum(["true", "false"]).optional(),
});

/**
 * Upload d'une archive ZIP (corps brut `application/zip`, en flux : jamais chargé en mémoire).
 * L'archive est validée, ses fichiers stockés par SHA-256, fusionnée avec la version parente s'il s'agit d'un patch,
 * puis le ZIP complet « prêt à lancer » (avec sql/install.sql) est reconstruit. Résultat : un BROUILLON.
 */
export const POST = route(
  { auth: "session", minRole: "ADMIN", rate: { name: "upload", limit: 30, windowMs: 3600_000 } },
  async ({ req, user, ip }) => {
    const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
    const version = cleanVersion(q.version);
    if (!version) throw new HttpError(400, "Numéro de version invalide (semver attendu, ex. 1.2.0)", "bad_version");
    if (await prisma.version.findUnique({ where: { version } })) throw new HttpError(409, `La version ${version} existe déjà`, "exists");

    const parent = q.parent
      ? await prisma.version.findUnique({ where: { version: q.parent.replace(/^v/i, "") } })
      : await currentVersion(q.channel);
    if (q.parent && !parent) throw new HttpError(404, `Version de base ${q.parent} introuvable`, "parent_not_found");
    if (q.mode === "patch" && !parent) throw new HttpError(400, "Aucune version de base : publiez d'abord une base complète", "no_parent");

    const e = env();
    const maxBytes = e.MAX_UPLOAD_MB * 1024 * 1024;
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new HttpError(413, `Archive trop volumineuse (max ${e.MAX_UPLOAD_MB} Mo)`, "too_large");
    if (!req.body) throw new HttpError(400, "Corps de requête vide", "empty");

    const dir = await mkdtemp(path.join(tmpdir(), "fbm-upload-"));
    const file = path.join(dir, "upload.zip");
    let built: Awaited<ReturnType<typeof buildArchive>> | null = null;
    try {
      let bytes = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) return cb(new HttpError(413, `Archive trop volumineuse (max ${e.MAX_UPLOAD_MB} Mo)`, "too_large"));
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(req.body as never), guard, createWriteStream(file));

      const processed = await processArchive(
        file,
        storage(),
        {
          maxFiles: e.MAX_ARCHIVE_FILES,
          maxFileBytes: e.MAX_FILE_MB * 1024 * 1024,
          maxTotalBytes: e.MAX_UNCOMPRESSED_MB * 1024 * 1024,
          maxRatio: e.MAX_COMPRESSION_RATIO,
          blockedExtensions: e.BLOCKED_EXTENSIONS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
        },
        // un patch ne contient souvent qu'un dossier (ex. resources/) : on ne retire pas le dossier racine par défaut
        { stripRoot: (q.stripRoot ?? (q.mode === "full" ? "true" : "false")) === "true" },
      );

      const parentManifest = parent ? getManifest(parent) : null;
      const release = await buildRelease(
        {
          version,
          mode: q.mode,
          parent: parent ? { version: parent.version, manifest: parentManifest! } : null,
          files: processed.files,
          deletePatterns: parseDeleteList(q.deletes ?? ""),
          siteName: (await getSettings()).siteName,
        },
        storage(),
      );
      const manifest = release.manifest;

      // ZIP complet reconstruit depuis les blobs : identique à ce qu'installe le launcher / fbm update
      built = await buildArchive(manifest, storage(), { version, channel: q.channel });
      const key = archiveKey(version, randomBytes(4).toString("hex"));
      await storage().putFile(key, built.file, "application/zip");
      const minRole = q.minRole ?? (q.channel === "BETA" ? "DEVELOPER" : "MEMBER");
      const totalSize = manifest.files.reduce((n, f) => n + f.size, 0);

      let created;
      try {
        created = await prisma.version.create({
          data: {
            version,
            channel: q.channel,
            minRole,
            kind: q.mode === "patch" ? "PATCH" : "FULL",
            parentId: parent?.id ?? null,
            diffSummary: release.summary as never,
            manifest: manifest as never,
            fileCount: manifest.files.length,
            totalSize: BigInt(totalSize),
            archiveKey: key,
            archiveSha256: built.sha256,
            archiveSize: BigInt(built.size),
            createdById: user!.id,
          },
        });
      } catch (err) {
        await storage().delete(key).catch(() => undefined);
        if (isUniqueViolation(err)) throw new HttpError(409, `La version ${version} existe déjà`, "exists");
        throw err;
      }

      const diff = diffManifests(parentManifest, manifest);
      await audit(
        user!.id,
        "version.upload",
        version,
        { mode: q.mode, parent: parent?.version ?? null, files: manifest.files.length, uploadBytes: bytes, newBlobs: processed.newBlobs, sql: release.summary.migrations.length, deleted: release.deleted },
        ip,
      );
      return {
        id: created.id,
        version,
        kind: created.kind,
        parent: parent?.version ?? null,
        fileCount: manifest.files.length,
        totalSize,
        archiveSha256: built.sha256,
        archiveSize: built.size,
        uploadSize: bytes,
        newBlobs: processed.newBlobs,
        reusedBlobs: processed.reusedBlobs,
        strippedRoot: processed.strippedRoot,
        migrations: release.summary.migrations,
        deleted: release.deleted,
        unmatchedDeletes: release.unmatchedDeletes,
        summary: release.summary.counts,
        diff: {
          against: parent?.version ?? null,
          added: diff.added.length,
          modified: diff.modified.length,
          removed: diff.removed.length,
          unchanged: diff.unchanged,
          downloadSize: diff.downloadSize,
        },
      };
    } catch (err) {
      if (err instanceof ArchiveError) throw new HttpError(422, err.message, "bad_archive");
      throw err;
    } finally {
      await built?.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
