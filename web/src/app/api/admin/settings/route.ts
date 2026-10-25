import { z } from "zod";
import { route, readJson } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getSettings, setSettings } from "@/lib/settings";
import { notifyMaintenance } from "@/lib/webhooks";

export const runtime = "nodejs";

export const GET = route({ auth: "session", minRole: "ADMIN" }, async () => ({ settings: await getSettings() }));

/** Uniquement http(s) ou chemin interne : bloque javascript:, data:, etc. */
const url = z
  .string()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//")), "URL http(s) ou chemin relatif attendu");

const schema = z.object({
  siteName: z.string().trim().min(1).max(60).optional(),
  tagline: z.string().trim().max(200).optional(),
  logoUrl: url.optional(),
  discordInviteUrl: url.optional(),
  launcherDownloadUrl: url.optional(),
  maintenance: z.object({ enabled: z.boolean(), message: z.string().trim().max(500) }).optional(),
  notifyDiscord: z.boolean().default(false),
});

export const PUT = route({ auth: "session", minRole: "ADMIN" }, async ({ req, user, ip }) => {
  const { notifyDiscord, ...patch } = await readJson(req, schema);
  const before = await getSettings();
  await setSettings(patch);
  let discord = false;
  if (patch.maintenance && patch.maintenance.enabled !== before.maintenance.enabled && notifyDiscord) {
    discord = await notifyMaintenance(patch.maintenance.enabled, patch.maintenance.message);
  }
  await audit(user!.id, "settings.update", null, { fields: Object.keys(patch), maintenance: patch.maintenance?.enabled }, ip);
  return { ok: true, discordNotified: discord };
});
