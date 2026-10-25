import { prisma } from "./db";
import { hasRole } from "./rbac";
import { compareVersions } from "./versions";
import type { AuthUser } from "./auth/session";

/** Versions publiées visibles pour un visiteur : anonymes = publiques (membre, stable) ; connectés = selon leur rôle. */
export async function visibleVersions(user: AuthUser | null) {
  const rows = await prisma.version.findMany({
    where: { status: "PUBLISHED" },
    include: { changes: { orderBy: { position: "asc" } }, _count: { select: { downloads: true } } },
  });
  return rows
    .filter((v) => (user ? hasRole(user.effective, v.minRole) : v.minRole === "MEMBER" && v.channel === "STABLE"))
    .sort((a, b) => compareVersions(a.version, b.version));
}
