import { env } from "./env";

const COLOR = 0x8b3dff;
const ALLOWED_HOSTS = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"];

interface Embed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
  image?: { url: string };
}

async function post(webhookUrl: string | undefined, embed: Embed, opts: { button?: { label: string; url: string }; mentionRoleId?: string }) {
  if (!webhookUrl) return false;
  const u = new URL(webhookUrl);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.includes(u.hostname)) {
    console.error("webhook: hôte non autorisé");
    return false;
  }
  u.searchParams.set("wait", "true");
  if (opts.button) u.searchParams.set("with_components", "true");
  const body = {
    username: "FiveM Base Manager",
    content: opts.mentionRoleId ? `<@&${opts.mentionRoleId}>` : undefined,
    // Seul le rôle explicitement configuré peut être mentionné (aucune mention utilisateur / @everyone).
    allowed_mentions: { parse: [], roles: opts.mentionRoleId ? [opts.mentionRoleId] : [] },
    embeds: [{ color: COLOR, timestamp: new Date().toISOString(), ...embed }],
    components: opts.button
      ? [{ type: 1, components: [{ type: 2, style: 5, label: opts.button.label, url: opts.button.url }] }]
      : undefined,
  };
  try {
    const res = await fetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error("webhook: HTTP", res.status);
    return res.ok;
  } catch (e) {
    console.error("webhook:", (e as Error).message);
    return false;
  }
}

const TYPE_ICON = { NEW: "🆕 **NEW**", FIX: "🛠️ **FIX**", IMPROVEMENT: "✨ **IMPROVEMENT**" } as const;

export interface PublishedVersionInfo {
  version: string;
  title?: string | null;
  summary?: string | null;
  minRole: string;
  changes: { type: keyof typeof TYPE_ICON; text: string }[];
  siteName: string;
}

export async function notifyVersionPublished(v: PublishedVersionInfo) {
  const e = env();
  // Une version réservée (VIP / dev) ne doit pas être annoncée dans le salon public.
  const hook = v.minRole === "MEMBER" ? e.DISCORD_WEBHOOK_URL : e.DISCORD_PRIVATE_WEBHOOK_URL;
  const lines = v.changes.slice(0, 15).map((c) => `${TYPE_ICON[c.type]} ${c.text}`);
  const more = v.changes.length > 15 ? `\n… et ${v.changes.length - 15} autres changements` : "";
  return post(
    hook,
    {
      title: `📦 ${v.siteName} — v${v.version}${v.title ? ` · ${v.title}` : ""}`,
      description: [v.summary, lines.join("\n") + more].filter(Boolean).join("\n\n").slice(0, 3800),
      url: `${e.APP_URL}/updates#v${v.version}`,
      fields: [{ name: "Mise à jour", value: "Via le launcher (différentielle) ou sur le site.", inline: false }],
    },
    {
      button: { label: "Voir la mise à jour", url: `${e.APP_URL}/updates#v${v.version}` },
      mentionRoleId: v.minRole === "MEMBER" ? e.DISCORD_NOTIFY_ROLE_ID : undefined,
    },
  );
}

export async function notifyAnnouncement(a: { kind: "NEWS" | "MAINTENANCE" | "NEW_RESOURCE"; title: string; body: string }) {
  const e = env();
  const icon = { NEWS: "📰", MAINTENANCE: "🔧", NEW_RESOURCE: "🧩" }[a.kind];
  const hook = a.kind === "MAINTENANCE" ? (e.DISCORD_MAINTENANCE_WEBHOOK_URL ?? e.DISCORD_WEBHOOK_URL) : e.DISCORD_WEBHOOK_URL;
  return post(
    hook,
    { title: `${icon} ${a.title}`, description: a.body.slice(0, 3800), url: e.APP_URL },
    { button: { label: "Ouvrir le site", url: e.APP_URL }, mentionRoleId: a.kind === "NEW_RESOURCE" ? e.DISCORD_NOTIFY_ROLE_ID : undefined },
  );
}

export async function notifyMaintenance(enabled: boolean, message: string) {
  const e = env();
  return post(
    e.DISCORD_MAINTENANCE_WEBHOOK_URL ?? e.DISCORD_WEBHOOK_URL,
    {
      title: enabled ? "🔧 Maintenance en cours" : "✅ Maintenance terminée",
      description: message || (enabled ? "Les téléchargements et le launcher peuvent être indisponibles." : "Tous les services sont de nouveau disponibles."),
      color: enabled ? 0xf59e0b : 0x22c55e,
    },
    {},
  );
}
