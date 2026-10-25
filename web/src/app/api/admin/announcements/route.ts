import { z } from "zod";
import { route, readJson } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notifyAnnouncement } from "@/lib/webhooks";

export const runtime = "nodejs";

export const GET = route({ auth: "session", minRole: "ADMIN" }, async () => ({
  announcements: await prisma.announcement.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
}));

const schema = z.object({
  kind: z.enum(["NEWS", "MAINTENANCE", "NEW_RESOURCE"]).default("NEWS"),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  pinned: z.boolean().default(false),
  sendToDiscord: z.boolean().default(false),
});

export const POST = route({ auth: "session", minRole: "ADMIN", rate: { name: "announce", limit: 30, windowMs: 3600_000 } }, async ({ req, user, ip }) => {
  const b = await readJson(req, schema);
  let sent = false;
  if (b.sendToDiscord) sent = await notifyAnnouncement({ kind: b.kind, title: b.title, body: b.body });
  const a = await prisma.announcement.create({
    data: { kind: b.kind, title: b.title, body: b.body, pinned: b.pinned, discordSent: sent, createdById: user!.id },
  });
  await audit(user!.id, "announcement.create", a.id, { kind: b.kind, discord: sent }, ip);
  return { announcement: a, discordNotified: sent };
});
