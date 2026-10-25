import { prisma } from "./db";
import { storage } from "./storage";
import { getSettings } from "./settings";

export type ServiceState = "operational" | "degraded" | "down" | "maintenance";
export interface ServiceStatus {
  id: string;
  name: string;
  state: ServiceState;
  latencyMs?: number;
}

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number }> {
  const t = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    return { ok: true, ms: Date.now() - t };
  } catch {
    return { ok: false, ms: Date.now() - t };
  }
}

const g = globalThis as unknown as { statusCache?: { at: number; value: ServiceStatus[] } };

export async function getServiceStatus(): Promise<ServiceStatus[]> {
  if (g.statusCache && Date.now() - g.statusCache.at < 30_000) return g.statusCache.value;
  const [settings, db, store, discord, current] = await Promise.all([
    getSettings().catch(() => null),
    timed(() => prisma.$queryRaw`SELECT 1`),
    timed(() => storage().exists("healthcheck")),
    timed(async () => {
      const r = await fetch("https://discord.com/api/v10/gateway", { signal: AbortSignal.timeout(3500) });
      if (!r.ok) throw new Error("http " + r.status);
    }),
    prisma.version.count({ where: { isCurrent: true, status: "PUBLISHED" } }).catch(() => 0),
  ]);
  const maint = !!settings?.maintenance.enabled;
  const state = (ok: boolean, ms: number): ServiceState => (maint ? "maintenance" : !ok ? "down" : ms > 1500 ? "degraded" : "operational");
  const value: ServiceStatus[] = [
    { id: "web", name: "Site web & API", state: maint ? "maintenance" : "operational" },
    { id: "db", name: "Base de données", state: state(db.ok, db.ms), latencyMs: db.ms },
    { id: "storage", name: "Stockage des fichiers", state: state(store.ok, store.ms), latencyMs: store.ms },
    { id: "launcher", name: "Launcher & mises à jour", state: maint ? "maintenance" : db.ok && store.ok && current > 0 ? "operational" : "degraded" },
    { id: "discord", name: "Connexion Discord", state: maint ? "maintenance" : discord.ok ? "operational" : "degraded", latencyMs: discord.ms },
  ];
  g.statusCache = { at: Date.now(), value };
  return value;
}
