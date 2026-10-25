import { z } from "zod";
import { route, readJson, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const schema = z.object({
  version: z.string().max(40),
  kind: z.enum(["INSTALL", "UPDATE", "REPAIR"]),
});

/** Le launcher signale une installation / mise à jour réussie (statistiques de téléchargement). */
export const POST = route({ auth: "bearer", rate: { name: "l-report", limit: 30, windowMs: 60_000 } }, async ({ req, user }) => {
  const body = await readJson(req, schema);
  const v = await prisma.version.findFirst({ where: { version: body.version.replace(/^v/i, ""), status: "PUBLISHED" } });
  if (!v) throw new HttpError(404, "Version introuvable", "not_found");
  await prisma.download.create({ data: { versionId: v.id, userId: user!.id, kind: body.kind } });
  return { ok: true };
});
