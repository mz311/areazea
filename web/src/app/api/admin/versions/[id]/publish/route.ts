import { z } from "zod";
import { route } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { notifyVersionPublished } from "@/lib/webhooks";
import { publish } from "@/lib/versions";

export const runtime = "nodejs";

const schema = z.object({ makeCurrent: z.boolean().default(true), notifyDiscord: z.boolean().default(true) });

export const POST = route<{ id: string }>({ auth: "session", minRole: "ADMIN" }, async ({ req, params, user, ip }) => {
  const raw = await req.json().catch(() => ({}));
  const body = schema.parse(raw);
  const v = await publish(params.id, body.makeCurrent);
  await audit(user!.id, "version.publish", v.version, { makeCurrent: body.makeCurrent }, ip);
  let discord = false;
  if (body.notifyDiscord) {
    const site = await getSettings();
    discord = await notifyVersionPublished({
      version: v.version,
      title: v.title,
      summary: v.summary,
      minRole: v.minRole,
      changes: v.changes.map((c) => ({ type: c.type, text: c.text })),
      siteName: site.siteName,
    });
  }
  return { ok: true, version: v.version, discordNotified: discord };
});
