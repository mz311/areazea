import type { Role } from "@prisma/client";
import { env } from "../env";
import { maxRole } from "../rbac";

const API = "https://discord.com/api/v10";
export const DISCORD_SCOPES = "identify guilds.members.read";

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export class DiscordError extends Error {}

export function authorizeUrl(state: string, challenge: string): string {
  const e = env();
  const u = new URL(`${API.replace("/api/v10", "")}/oauth2/authorize`);
  u.searchParams.set("client_id", e.DISCORD_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${e.APP_URL}/api/auth/discord/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", DISCORD_SCOPES);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "none");
  return u.toString();
}

async function discord<T>(path: string, init: RequestInit): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) throw new DiscordError(`Discord ${path} → HTTP ${res.status}`);
  return { status: res.status, data: (await res.json()) as T };
}

export async function exchangeCode(code: string, verifier: string): Promise<string> {
  const e = env();
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: e.DISCORD_CLIENT_ID,
      client_secret: e.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${e.APP_URL}/api/auth/discord/callback`,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new DiscordError(`Échange du code OAuth refusé (HTTP ${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new DiscordError("Réponse OAuth sans access_token");
  return json.access_token;
}

export async function fetchUser(accessToken: string): Promise<DiscordUser> {
  const r = await discord<DiscordUser>("/users/@me", { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.data) throw new DiscordError("Utilisateur Discord introuvable");
  return r.data;
}

/** Rôles du membre dans le serveur (via son propre jeton OAuth) ; null s'il n'est pas membre. */
export async function fetchOwnGuildRoles(accessToken: string): Promise<string[] | null> {
  const r = await discord<{ roles: string[] }>(`/users/@me/guilds/${env().DISCORD_GUILD_ID}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return r.data ? r.data.roles : null;
}

/** Rôles via le bot (rafraîchissement sans reconnexion). `undefined` si aucun bot n'est configuré. */
export async function fetchRolesWithBot(discordId: string): Promise<string[] | null | undefined> {
  const e = env();
  if (!e.DISCORD_BOT_TOKEN) return undefined;
  const r = await discord<{ roles: string[] }>(`/guilds/${e.DISCORD_GUILD_ID}/members/${discordId}`, {
    headers: { Authorization: `Bot ${e.DISCORD_BOT_TOKEN}` },
  });
  return r.data ? r.data.roles : null;
}

export interface RoleConfig {
  member: string[];
  vip: string[];
  developer: string[];
  admin: string[];
  adminUserIds: string[];
}

export function roleConfigFromEnv(): RoleConfig {
  const e = env();
  return {
    member: e.DISCORD_ROLE_MEMBER_IDS,
    vip: e.DISCORD_ROLE_VIP_IDS,
    developer: e.DISCORD_ROLE_DEVELOPER_IDS,
    admin: e.DISCORD_ROLE_ADMIN_IDS,
    adminUserIds: e.ADMIN_DISCORD_IDS,
  };
}

/**
 * Calcule l'accès depuis les rôles Discord. `roleIds === null` = pas membre du serveur.
 * Si des rôles "membre" sont configurés, ils sont requis pour être considéré comme membre vérifié.
 */
export function computeAccess(cfg: RoleConfig, discordId: string, roleIds: string[] | null): { inGuild: boolean; role: Role } {
  if (roleIds === null) return { inGuild: false, role: cfg.adminUserIds.includes(discordId) ? "ADMIN" : "MEMBER" };
  const has = (list: string[]) => list.some((id) => roleIds.includes(id));
  let role: Role = "MEMBER";
  if (has(cfg.vip)) role = maxRole(role, "VIP");
  if (has(cfg.developer)) role = maxRole(role, "DEVELOPER");
  if (has(cfg.admin) || cfg.adminUserIds.includes(discordId)) role = maxRole(role, "ADMIN");
  const verified = cfg.member.length === 0 || has(cfg.member) || role !== "MEMBER";
  return { inGuild: verified, role };
}

export function avatarUrl(u: { discordId: string; avatar: string | null }, size = 128): string {
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.discordId}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=${size}`;
  const idx = Number((BigInt(u.discordId) >> BigInt(22)) % BigInt(6));
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}
