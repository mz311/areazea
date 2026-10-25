import { route, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { assertCanDownload } from "@/lib/access";
import { assertNotMaintenance } from "@/lib/maintenance";
import { getSettings } from "@/lib/settings";
import { storage } from "@/lib/storage";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** Génère un lien de téléchargement temporaire (ZIP complet) après contrôle du rôle Discord. */
export const POST = route<{ version: string }>(
  { auth: "session", rate: { name: "dl-link", limit: 20, windowMs: 3600_000 } },
  async ({ user, params, ip }) => {
    const v = await prisma.version.findUnique({ where: { version: params.version.replace(/^v/i, "") } });
    if (!v || v.status !== "PUBLISHED" || !v.archiveKey) throw new HttpError(404, "Version introuvable", "not_found");
    assertCanDownload(user!, v);
    await assertNotMaintenance(user!);

    const ttl = env().DOWNLOAD_URL_TTL_SECONDS;
    const site = await getSettings();
    const url = await storage().signedUrl(v.archiveKey, {
      expiresIn: ttl,
      filename: `${site.siteName.replace(/[^\w-]+/g, "-")}-v${v.version}.zip`,
      contentType: "application/zip",
    });
    await prisma.download.create({ data: { versionId: v.id, userId: user!.id, kind: "ZIP" } });
    await audit(user!.id, "download.zip", v.version, undefined, ip);
    return {
      url,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      sha256: v.archiveSha256,
      size: Number(v.archiveSize),
      version: v.version,
    };
  },
);
