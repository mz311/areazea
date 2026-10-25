import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";

const base = {
  DATABASE_URL: "postgresql://x",
  APP_SECRET: "s".repeat(40),
  DISCORD_CLIENT_ID: "1",
  DISCORD_CLIENT_SECRET: "x",
  DISCORD_GUILD_ID: "2",
  APP_URL: "https://base.example.com",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
  DISCORD_PRIVATE_WEBHOOK_URL: "https://discord.com/api/webhooks/2/staff",
  DISCORD_MAINTENANCE_WEBHOOK_URL: "https://discord.com/api/webhooks/3/maint",
  DISCORD_NOTIFY_ROLE_ID: "555",
};

let calls: { url: URL; body: any }[] = [];

beforeEach(() => {
  calls = [];
  Object.assign(process.env, base);
  resetEnvCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: new URL(String(url)), body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(base)) delete process.env[k];
  resetEnvCache();
});

const info = (over = {}) => ({
  version: "1.2.0",
  title: "Gros patch",
  summary: "Résumé",
  minRole: "MEMBER",
  siteName: "Ma Base",
  changes: [
    { type: "NEW" as const, text: "Garage" },
    { type: "FIX" as const, text: "Spawn" },
  ],
  ...over,
});

describe("webhooks Discord", () => {
  it("annonce une version : embed, bouton lien vers le site, seul le rôle configuré est mentionné", async () => {
    const { notifyVersionPublished } = await import("@/lib/webhooks");
    expect(await notifyVersionPublished(info())).toBe(true);
    const { url, body } = calls[0];
    expect(url.pathname).toBe("/api/webhooks/1/abc");
    expect(url.searchParams.get("with_components")).toBe("true");
    const e = body.embeds[0];
    expect(e.title).toContain("v1.2.0");
    expect(e.description).toContain("🆕 **NEW** Garage");
    expect(e.description).toContain("🛠️ **FIX** Spawn");
    expect(e.url).toBe("https://base.example.com/updates#v1.2.0");
    expect(body.components[0].components[0]).toMatchObject({ type: 2, style: 5, url: "https://base.example.com/updates#v1.2.0" });
    expect(body.content).toBe("<@&555>");
    expect(body.allowed_mentions).toEqual({ parse: [], roles: ["555"] });
  });

  it("une version réservée (VIP/dev) va dans le salon staff, sans mention", async () => {
    const { notifyVersionPublished } = await import("@/lib/webhooks");
    await notifyVersionPublished(info({ minRole: "VIP" }));
    expect(calls[0].url.pathname).toBe("/api/webhooks/2/staff");
    expect(calls[0].body.content).toBeUndefined();
    expect(calls[0].body.allowed_mentions.roles).toEqual([]);
  });

  it("maintenance : salon dédié, couleur selon l'état", async () => {
    const { notifyMaintenance } = await import("@/lib/webhooks");
    await notifyMaintenance(true, "Migration");
    await notifyMaintenance(false, "");
    expect(calls[0].url.pathname).toBe("/api/webhooks/3/maint");
    expect(calls[0].body.embeds[0]).toMatchObject({ title: expect.stringContaining("en cours"), color: 0xf59e0b });
    expect(calls[1].body.embeds[0]).toMatchObject({ title: expect.stringContaining("terminée"), color: 0x22c55e });
  });

  it("annonce de ressource : mention du rôle ; actualité : aucune mention", async () => {
    const { notifyAnnouncement } = await import("@/lib/webhooks");
    await notifyAnnouncement({ kind: "NEW_RESOURCE", title: "Nouvelle ressource", body: "x" });
    await notifyAnnouncement({ kind: "NEWS", title: "Actu", body: "y" });
    expect(calls[0].body.content).toBe("<@&555>");
    expect(calls[1].body.content).toBeUndefined();
  });

  it("n'envoie rien sans webhook configuré et refuse un hôte non Discord", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    resetEnvCache();
    const { notifyVersionPublished } = await import("@/lib/webhooks");
    expect(await notifyVersionPublished(info())).toBe(false);
    process.env.DISCORD_WEBHOOK_URL = "https://evil.example.com/api/webhooks/1/abc";
    resetEnvCache();
    expect(await notifyVersionPublished(info())).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("tronque les très longs changelogs", async () => {
    const { notifyVersionPublished } = await import("@/lib/webhooks");
    const changes = Array.from({ length: 40 }, (_, i) => ({ type: "NEW" as const, text: `Chose ${i}` }));
    await notifyVersionPublished(info({ changes }));
    expect(calls[0].body.embeds[0].description).toContain("et 25 autres changements");
    expect(calls[0].body.embeds[0].description.length).toBeLessThan(4000);
  });
});
