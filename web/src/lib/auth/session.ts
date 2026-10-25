import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import { prisma } from "../db";
import { env, isProd } from "../env";
import { randomToken, sha256Hex } from "../crypto";
import { effectiveRole } from "../rbac";
import { fetchRolesWithBot, computeAccess, roleConfigFromEnv } from "./discord";

export const SESSION_COOKIE = "fbm_session";
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
const ROLE_REFRESH_MS = 10 * 60 * 1000;

export type AuthUser = User & { effective: ReturnType<typeof effectiveRole> };

/** Les comptes listés dans ADMIN_DISCORD_IDS sont toujours administrateurs (amorçage, pas de verrouillage possible). */
export const withEffective = (u: User): AuthUser => ({
  ...u,
  effective: env().ADMIN_DISCORD_IDS.includes(u.discordId) ? "ADMIN" : effectiveRole(u),
});

export function cookieOptions(maxAgeSeconds: number) {
  return { httpOnly: true, secure: isProd() || env().APP_URL.startsWith("https://"), sameSite: "lax" as const, path: "/", maxAge: maxAgeSeconds };
}

/** Crée la session en base et pose le cookie sur la réponse fournie. */
export async function createSession(res: NextResponse, userId: string, userAgent?: string | null): Promise<void> {
  const token = randomToken(32);
  await prisma.session.create({
    data: { tokenHash: sha256Hex(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS), userAgent: userAgent?.slice(0, 200) },
  });
  res.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS / 1000));
}

export async function destroySession(res: NextResponse): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
  res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
}

/** Utilisateur de la session courante (cookie), ou null. Les comptes bannis n'ont pas de session valide. */
export async function getSessionUser(): Promise<AuthUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date() || s.user.banned) return null;
  return withEffective(await refreshMembership(s.user));
}

/**
 * Met à jour rôles / appartenance depuis Discord via le bot (au plus toutes les 10 minutes).
 * Si Discord est injoignable ou qu'aucun bot n'est configuré, les valeurs en cache sont conservées.
 */
export async function refreshMembership(user: User): Promise<User> {
  if (!env().DISCORD_BOT_TOKEN) return user;
  if (user.rolesCheckedAt && Date.now() - user.rolesCheckedAt.getTime() < ROLE_REFRESH_MS) return user;
  try {
    const roles = await fetchRolesWithBot(user.discordId);
    if (roles === undefined) return user;
    const { inGuild, role } = computeAccess(roleConfigFromEnv(), user.discordId, roles);
    return await prisma.user.update({ where: { id: user.id }, data: { inGuild, role, rolesCheckedAt: new Date() } });
  } catch (e) {
    console.error("refreshMembership:", (e as Error).message);
    return user;
  }
}
