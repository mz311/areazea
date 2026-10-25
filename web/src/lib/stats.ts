import { prisma } from "./db";

export async function getAdminStats() {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [totalDownloads, users, perVersion, perDay, byRole, recentUsers] = await Promise.all([
    prisma.download.count({ where: { kind: { in: ["ZIP", "INSTALL"] } } }),
    prisma.user.count(),
    prisma.download.groupBy({ by: ["versionId", "kind"], _count: true }),
    prisma.$queryRaw<{ day: Date; n: number }[]>`
      SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS n
      FROM "Download" WHERE "createdAt" >= ${since} AND kind IN ('ZIP','INSTALL')
      GROUP BY 1 ORDER BY 1`,
    prisma.user.groupBy({ by: ["role"], _count: true }),
    prisma.user.count({ where: { lastLoginAt: { gte: since } } }),
  ]);
  const versions = await prisma.version.findMany({ select: { id: true, version: true, status: true, isCurrent: true } });
  const vmap = new Map(versions.map((v) => [v.id, v]));
  const rows = new Map<string, { version: string; isCurrent: boolean; zip: number; install: number; update: number; repair: number }>();
  for (const g of perVersion) {
    const v = vmap.get(g.versionId);
    if (!v) continue;
    const r = rows.get(v.id) ?? { version: v.version, isCurrent: v.isCurrent, zip: 0, install: 0, update: 0, repair: 0 };
    const k = g.kind.toLowerCase() as "zip" | "install" | "update" | "repair";
    r[k] += g._count;
    rows.set(v.id, r);
  }
  // Remplit les jours sans téléchargement pour un graphique continu.
  const byDay = new Map(perDay.map((d) => [d.day.toISOString().slice(0, 10), d.n]));
  const days: { day: string; n: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    days.push({ day: d, n: byDay.get(d) ?? 0 });
  }
  return {
    totalDownloads,
    users,
    activeUsers30d: recentUsers,
    byRole: Object.fromEntries(byRole.map((r) => [r.role, r._count])),
    downloadsPerDay: days,
    perVersion: [...rows.values()],
    publishedVersions: versions.filter((v) => v.status === "PUBLISHED").length,
  };
}
