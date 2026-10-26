import { z } from "zod";
import { route, readJson, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { deleteVersion, getManifest, serializeVersion } from "@/lib/versions";
import { diffManifests } from "@/lib/manifest";
import { blobKey, storage } from "@/lib/storage";

export const runtime = "nodejs";

export const GET = route<{ id: string }>({ auth: "session", minRole: "ADMIN" }, async ({ params }) => {
  const v = await prisma.version.findUnique({ where: { id: params.id }, include: { changes: { orderBy: { position: "asc" } }, parent: { select: { version: true } } } });
  if (!v) throw new HttpError(404, "Version introuvable", "not_found");
  const manifest = getManifest(v);
  const LIMIT = 64 * 1024;
  const sql = await Promise.all(
    (manifest.migrations ?? [])
      .filter((m) => m.version === v.version)
      .map(async (m) => {
        const obj = await storage().get(blobKey(m.sha256));
        const chunks: Buffer[] = [];
        for await (const c of obj.stream) chunks.push(c as Buffer);
        return { name: m.name, size: m.size, content: Buffer.concat(chunks).subarray(0, LIMIT).toString("utf8"), truncated: m.size > LIMIT };
      }),
  );
  // comparaison avec la version de base (patch) ou, à défaut, la version courante du canal
  const prev = v.parentId
    ? await prisma.version.findUnique({ where: { id: v.parentId } })
    : await prisma.version.findFirst({ where: { channel: v.channel, isCurrent: true, NOT: { id: v.id } } });
  const d = diffManifests(prev ? getManifest(prev) : null, manifest);
  return {
    version: { ...serializeVersion(v), changes: v.changes, parent: v.parent?.version ?? null },
    sql,
    manifest: { managedDirs: manifest.managedDirs, protected: manifest.protected, files: manifest.files.slice(0, 2000), truncated: manifest.files.length > 2000 },
    diff: { against: prev?.version ?? null, added: d.added.length, modified: d.modified.length, removed: d.removed.length, downloadSize: d.downloadSize },
  };
});

const pattern = z.string().min(1).max(200).regex(/^[^\\\u0000-\u001f]+$/);

const updateSchema = z.object({
  title: z.string().trim().max(120).nullable().optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  minRole: z.enum(["MEMBER", "VIP", "DEVELOPER", "ADMIN"]).optional(),
  channel: z.enum(["STABLE", "BETA"]).optional(),
  protected: z.array(pattern).max(100).optional(),
  managedDirs: z.array(z.string().min(1).max(100).regex(/^[^/\\]+$/)).max(100).optional(),
  changes: z
    .array(
      z.object({
        type: z.enum(["NEW", "FIX", "IMPROVEMENT"]),
        text: z.string().trim().min(1).max(500),
        imageId: z.string().regex(/^[a-z0-9]{10,40}$/).nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
});

export const PUT = route<{ id: string }>({ auth: "session", minRole: "ADMIN" }, async ({ req, params, user, ip }) => {
  const body = await readJson(req, updateSchema);
  const v = await prisma.version.findUnique({ where: { id: params.id } });
  if (!v) throw new HttpError(404, "Version introuvable", "not_found");
  const draft = v.status === "DRAFT";
  if (!draft && (body.channel || body.protected || body.managedDirs)) {
    throw new HttpError(409, "Canal, fichiers protégés et dossiers gérés ne sont modifiables que sur un brouillon", "not_draft");
  }
  if (body.changes) {
    const ids = [...new Set(body.changes.map((c) => c.imageId).filter(Boolean) as string[])];
    if (ids.length && (await prisma.mediaAsset.count({ where: { id: { in: ids } } })) !== ids.length) {
      throw new HttpError(400, "Image inconnue", "bad_image");
    }
  }
  const manifest = getManifest(v);
  if (body.protected) manifest.protected = body.protected;
  if (body.managedDirs) manifest.managedDirs = body.managedDirs;

  await prisma.$transaction([
    prisma.version.update({
      where: { id: v.id },
      data: {
        title: body.title === undefined ? undefined : body.title || null,
        summary: body.summary === undefined ? undefined : body.summary || null,
        minRole: body.minRole,
        channel: body.channel,
        manifest: body.protected || body.managedDirs ? (manifest as never) : undefined,
      },
    }),
    ...(body.changes
      ? [
          prisma.change.deleteMany({ where: { versionId: v.id } }),
          prisma.change.createMany({
            data: body.changes.map((c, i) => ({ versionId: v.id, type: c.type, text: c.text, imageId: c.imageId ?? null, position: i })),
          }),
        ]
      : []),
  ]);
  await audit(user!.id, "version.update", v.version, { fields: Object.keys(body) }, ip);
  return { ok: true };
});

export const DELETE = route<{ id: string }>({ auth: "session", minRole: "ADMIN" }, async ({ params, user, ip }) => {
  const v = await deleteVersion(params.id);
  await audit(user!.id, "version.delete", v.version, undefined, ip);
  return { ok: true };
});
