import { z } from "zod";
import { route, readJson, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const schema = z.object({
  roleOverride: z.enum(["MEMBER", "VIP", "DEVELOPER", "ADMIN"]).nullable().optional(),
  banned: z.boolean().optional(),
});

export const PATCH = route<{ id: string }>({ auth: "session", minRole: "ADMIN" }, async ({ req, params, user, ip }) => {
  const b = await readJson(req, schema);
  const target = await prisma.user.findUnique({ where: { id: params.id } });
  if (!target) throw new HttpError(404, "Utilisateur introuvable", "not_found");
  if (target.id === user!.id && (b.banned || (b.roleOverride !== undefined && b.roleOverride !== "ADMIN"))) {
    throw new HttpError(400, "Vous ne pouvez pas vous retirer vos propres droits", "self_lockout");
  }
  if (env().ADMIN_DISCORD_IDS.includes(target.discordId) && (b.banned || b.roleOverride)) {
    throw new HttpError(400, "Ce compte est administrateur permanent (ADMIN_DISCORD_IDS)", "protected_admin");
  }
  await prisma.user.update({ where: { id: target.id }, data: b });
  if (b.banned) {
    await prisma.session.deleteMany({ where: { userId: target.id } });
    await prisma.launcherToken.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  await audit(user!.id, "user.update", target.discordId, b, ip);
  return { ok: true };
});
