import { prisma } from "./db";
import { env } from "./env";

export interface SiteSettings {
  siteName: string;
  tagline: string;
  logoUrl: string;
  discordInviteUrl: string;
  launcherDownloadUrl: string;
  maintenance: { enabled: boolean; message: string };
}

export const SETTING_DEFAULTS = (): SiteSettings => ({
  siteName: "FiveM Base",
  tagline: "La base FiveM de notre communauté — toujours à jour, en un clic.",
  logoUrl: "",
  discordInviteUrl: env().DISCORD_INVITE_URL ?? "",
  launcherDownloadUrl: env().LAUNCHER_DOWNLOAD_URL ?? "",
  maintenance: { enabled: false, message: "" },
});

export async function getSettings(): Promise<SiteSettings> {
  const rows = await prisma.setting.findMany();
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS() };
  for (const r of rows) out[r.key] = r.value;
  return out as unknown as SiteSettings;
}

export async function setSettings(patch: Partial<SiteSettings>): Promise<void> {
  await prisma.$transaction(
    Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([key, value]) =>
        prisma.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }),
      ),
  );
}
