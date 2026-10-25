import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "@/lib/env";

/** Charge .env.example comme le ferait Next.js (KEY=valeur, # commentaires). */
function load(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});

describe(".env.example", () => {
  const example = load(path.resolve(__dirname, "../.env.example"));

  it("est valide une fois les 3 identifiants Discord renseignés (valeurs vides ignorées)", () => {
    Object.assign(process.env, example, { DISCORD_CLIENT_ID: "1", DISCORD_CLIENT_SECRET: "x", DISCORD_GUILD_ID: "2" });
    resetEnvCache();
    const e = env();
    expect(e.STORAGE_DRIVER).toBe("local");
    expect(e.DISCORD_ROLE_VIP_IDS).toEqual([]);
    expect(e.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(e.DOWNLOAD_URL_TTL_SECONDS).toBe(300);
    expect(e.BLOCKED_EXTENSIONS).toContain(".exe");
  });

  it("documente toutes les variables lues par l'application", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/env.ts"), "utf8");
    const used = [...src.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*z\./gm)].map((m) => m[1]).filter((k) => k !== "NODE_ENV");
    const missing = used.filter((k) => !(k in example));
    expect(missing).toEqual([]);
  });

  it("refuse le secret d'exemple en production", () => {
    Object.assign(process.env, example, { DISCORD_CLIENT_ID: "1", DISCORD_CLIENT_SECRET: "x", DISCORD_GUILD_ID: "2", NODE_ENV: "production" });
    resetEnvCache();
    expect(() => env()).toThrow(/APP_SECRET/);
  });

  it("signale clairement une configuration invalide", () => {
    Object.assign(process.env, example, { DISCORD_CLIENT_ID: "1", DISCORD_CLIENT_SECRET: "x", DISCORD_GUILD_ID: "2", APP_SECRET: "trop-court" });
    resetEnvCache();
    expect(() => env()).toThrow(/APP_SECRET doit faire au moins 32/);
  });
});
