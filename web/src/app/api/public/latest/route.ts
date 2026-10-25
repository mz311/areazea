import { route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { currentVersion } from "@/lib/versions";

export const runtime = "nodejs";

/** Informations publiques : dernière version stable + compteur de téléchargements. */
export const GET = route({ rate: { name: "pub-latest", limit: 120, windowMs: 60_000 } }, async () => {
  const [v, downloads] = await Promise.all([
    currentVersion("STABLE"),
    prisma.download.count({ where: { kind: { in: ["ZIP", "INSTALL"] } } }),
  ]);
  return {
    downloads,
    latest: v && {
      version: v.version,
      title: v.title,
      publishedAt: v.publishedAt,
      fileCount: v.fileCount,
      totalSize: Number(v.totalSize),
      minRole: v.minRole,
    },
  };
});
