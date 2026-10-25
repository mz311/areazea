import { z } from "zod";
import { route } from "@/lib/api";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const query = z.object({ page: z.coerce.number().int().min(1).default(1) });
const PAGE = 50;

export const GET = route({ auth: "session", minRole: "ADMIN" }, async ({ req }) => {
  const { page } = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE, take: PAGE, include: { actor: { select: { username: true, globalName: true } } } }),
    prisma.auditLog.count(),
  ]);
  return {
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    logs: rows.map((l) => ({ id: l.id, action: l.action, target: l.target, meta: l.meta, ip: l.ip, createdAt: l.createdAt, actor: l.actor ? (l.actor.globalName ?? l.actor.username) : null })),
  };
});
