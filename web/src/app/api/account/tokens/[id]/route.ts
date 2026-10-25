import { route, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export const DELETE = route<{ id: string }>({ auth: "session" }, async ({ user, params, ip }) => {
  const r = await prisma.launcherToken.updateMany({
    where: { id: params.id, userId: user!.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!r.count) throw new HttpError(404, "Jeton introuvable", "not_found");
  await audit(user!.id, "launcher.token.revoke", params.id, undefined, ip);
  return { ok: true };
});
