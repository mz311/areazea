import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { route, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { ArchiveError } from "@/lib/archive/paths";
import { processArchive } from "@/lib/archive/process";
import { buildManifest, diffManifests } from "@/lib/manifest";
import { archiveKey, storage } from "@/lib/storage";
import { cleanVersion, currentVersion, getManifest, isUniqueViolation } from "@/lib/versions";

export const runtime = "nodejs";
export const maxDuration = 3600;

const query = z.object({
  version: z.string(),
  channel: z.enum(["STABLE", "BETA"]).default("STABLE"),
  minRole: z.enum(["MEMBER", "VIP", "DEVELOPER", "ADMIN"]).optional(),
  stripRoot: z.enum(["true", "false"]).default("true"),
});

/**
 * Upload d'une archive ZIP de la base (corps brut `application/zip`, en flux : jamais chargé en mémoire).
 * Valide l'archive, stocke les fichiers par hash SHA-256, génère le manifeste et crée un BROUILLON.
 */
export const POST = route(
  { auth: "session", minRole: "ADMIN", rate: { name: "upload", limit: 10, windowMs: 3600_000 } },
  async ({ req, user, ip }) => {
    const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
    const version = cleanVersion(q.version);
    if (!version) throw new HttpError(400, "Numéro de version invalide (semver attendu, ex. 1.2.0)", "bad_version");
    if (await prisma.version.findUnique({ where: { version } })) throw new HttpError(409, `La version ${version} existe déjà`, "exists");

    const e = env();
    const maxBytes = e.MAX_UPLOAD_MB * 1024 * 1024;
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new HttpError(413, `Archive trop volumineuse (max ${e.MAX_UPLOAD_MB} Mo)`, "too_large");
    if (!req.body) throw new HttpError(400, "Corps de requête vide", "empty");

    const dir = await mkdtemp(path.join(tmpdir(), "fbm-upload-"));
    const file = path.join(dir, "upload.zip");
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) return cb(new HttpError(413, `Archive trop volumineuse (max ${e.MAX_UPLOAD_MB} Mo)`, "too_large"));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(req.body as never), guard, createWriteStream(file));
      const archiveSha256 = hash.digest("hex");

      const result = await processArchive(
        file,
        storage(),
        {
          maxFiles: e.MAX_ARCHIVE_FILES,
          maxFileBytes: e.MAX_FILE_MB * 1024 * 1024,
          maxTotalBytes: e.MAX_UNCOMPRESSED_MB * 1024 * 1024,
          maxRatio: e.MAX_COMPRESSION_RATIO,
          blockedExtensions: e.BLOCKED_EXTENSIONS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
        },
        { stripRoot: q.stripRoot === "true" },
      );

      const key = archiveKey(version, randomBytes(4).toString("hex"));
      await storage().putFile(key, file, "application/zip");
      const manifest = buildManifest(result.files);
      const minRole = q.minRole ?? (q.channel === "BETA" ? "DEVELOPER" : "MEMBER");

      let created;
      try {
        created = await prisma.version.create({
          data: {
            version,
            channel: q.channel,
            minRole,
            manifest: manifest as never,
            fileCount: manifest.files.length,
            totalSize: BigInt(result.totalSize),
            archiveKey: key,
            archiveSha256,
            archiveSize: BigInt(bytes),
            createdById: user!.id,
          },
        });
      } catch (err) {
        await storage().delete(key).catch(() => undefined);
        if (isUniqueViolation(err)) throw new HttpError(409, `La version ${version} existe déjà`, "exists");
        throw err;
      }

      const base = await currentVersion(q.channel);
      const diff = diffManifests(base ? getManifest(base) : null, manifest);
      await audit(user!.id, "version.upload", version, { files: manifest.files.length, bytes, newBlobs: result.newBlobs }, ip);
      return {
        id: created.id,
        version,
        fileCount: manifest.files.length,
        totalSize: result.totalSize,
        archiveSha256,
        archiveSize: bytes,
        newBlobs: result.newBlobs,
        reusedBlobs: result.reusedBlobs,
        strippedRoot: result.strippedRoot,
        diff: {
          against: base?.version ?? null,
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
      await rm(dir, { recursive: true, force: true });
    }
  },
);
