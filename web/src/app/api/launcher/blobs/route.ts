import { z } from "zod";
import { route, readJson, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { assertCanDownload } from "@/lib/access";
import { assertNotMaintenance } from "@/lib/maintenance";
import { getManifest } from "@/lib/versions";
import { blobKey, storage } from "@/lib/storage";

export const runtime = "nodejs";

const schema = z.object({
  version: z.string().max(40),
  hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(500),
});

/**
 * Liens temporaires pour une liste de blobs. Chaque hash DOIT appartenir au manifeste de la version
 * demandée (et la version doit être accessible au rôle de l'utilisateur) : aucun accès à des blobs arbitraires.
 */
export const POST = route({ auth: "bearer", rate: { name: "l-blobs", limit: 120, windowMs: 60_000 } }, async ({ req, user }) => {
  const body = await readJson(req, schema);
  await assertNotMaintenance(user!);
  const v = await prisma.version.findFirst({ where: { version: body.version.replace(/^v/i, ""), status: "PUBLISHED" } });
  if (!v) throw new HttpError(404, "Version introuvable", "not_found");
  assertCanDownload(user!, v);
  const allowed = new Set(getManifest(v).files.map((f) => f.sha256));
  const ttl = env().DOWNLOAD_URL_TTL_SECONDS;
  const urls: Record<string, string> = {};
  for (const h of new Set(body.hashes)) {
    if (!allowed.has(h)) throw new HttpError(403, "Fichier absent du manifeste de cette version", "not_in_manifest");
    urls[h] = await storage().signedUrl(blobKey(h), { expiresIn: ttl, contentType: "application/octet-stream" });
  }
  return { urls, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
});
