import { z } from "zod";
import { route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { avatarUrl } from "@/lib/auth/discord";
import { withEffective } from "@/lib/auth/session";

export const runtime = "nodejs";

const query = z.object({ q: z.string().max(60).optional(), page: z.coerce.number().int().min(1).default(1) });
const PAGE = 25;

export const GET = route({ auth: "session", minRole: "ADMIN" }, async ({ req }) => {
  const { q, page } = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const where = q ? { OR: [{ username: { contains: q, mode: "insensitive" as const } }, { globalName: { contains: q, mode: "insensitive" as const } }, { discordId: q }] } : {};
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { lastLoginAt: "desc" }, skip: (page - 1) * PAGE, take: PAGE, include: { _count: { select: { downloads: true } } } }),
    prisma.user.count({ where }),
  ]);
  return {
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    users: rows.map((u) => ({
      id: u.id,
      discordId: u.discordId,
      name: u.globalName ?? u.username,
      username: u.username,
      avatar: avatarUrl(u, 64),
      role: u.role,
      roleOverride: u.roleOverride,
      effective: withEffective(u).effective,
      inGuild: u.inGuild,
      banned: u.banned,
      downloads: u._count.downloads,
      lastLoginAt: u.lastLoginAt,
    })),
  };
});
