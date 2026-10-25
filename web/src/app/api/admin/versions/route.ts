import { route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { serializeVersion } from "@/lib/versions";

export const runtime = "nodejs";

export const GET = route({ auth: "session", minRole: "ADMIN" }, async () => {
  const rows = await prisma.version.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { downloads: true, changes: true } }, createdBy: { select: { username: true } } },
  });
  return { versions: rows.map(({ _count, createdBy, ...v }) => ({ ...serializeVersion(v), downloads: _count.downloads, changeCount: _count.changes, createdBy: createdBy?.username ?? null })) };
});
