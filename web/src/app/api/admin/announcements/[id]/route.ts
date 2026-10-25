import { z } from "zod";
import { route, readJson, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const schema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  pinned: z.boolean().optional(),
});

export const PUT = route<{ id: string }>({ auth: "session", minRole: "ADMIN" }, async ({ req, params, user, ip }) => {
  const b = await readJson(req, schema);
  const r = await prisma.announcement.updateMany({ where: { id: params.id }, data: b });
  if (!r.count) throw new HttpError(404, "Annonce introuvable", "not_found");
  await audit(user!.id, "announcement.update", params.id, { fields: Object.keys(b) }, ip);
  return { ok: true };
});

export const DELETE = route<{ id: string }>({ auth: "session", minRole: "ADMIN" }, async ({ params, user, ip }) => {
  const r = await prisma.announcement.deleteMany({ where: { id: params.id } });
  if (!r.count) throw new HttpError(404, "Annonce introuvable", "not_found");
  await audit(user!.id, "announcement.delete", params.id, undefined, ip);
  return { ok: true };
});
