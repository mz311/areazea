import { NextRequest, NextResponse } from "next/server";
import { computeAccess, exchangeCode, fetchOwnGuildRoles, fetchUser, roleConfigFromEnv } from "@/lib/auth/discord";
import { cookieOptions, createSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { safeEqual, verifyPayload } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/api";
import { safeReturnTo } from "@/lib/redirect";
import { OAUTH_COOKIE } from "../login/route";

export const runtime = "nodejs";

const to = (path: string) => {
  const res = NextResponse.redirect(new URL(path, env().APP_URL));
  res.cookies.set(OAUTH_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
  return res;
};

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (p.get("error")) return to("/?error=cancelled");

  const cookie = req.cookies.get(OAUTH_COOKIE)?.value;
  const data = cookie ? verifyPayload<{ s: string; v: string; r: string }>(env().APP_SECRET, cookie) : null;
  const state = p.get("state");
  const code = p.get("code");
  if (!data || !state || !code || !safeEqual(state, data.s)) return to("/?error=oauth_state");

  try {
    const accessToken = await exchangeCode(code, data.v);
    const du = await fetchUser(accessToken);
    const roles = await fetchOwnGuildRoles(accessToken);
    const access = computeAccess(roleConfigFromEnv(), du.id, roles);
    const user = await prisma.user.upsert({
      where: { discordId: du.id },
      create: {
        discordId: du.id,
        username: du.username,
        globalName: du.global_name ?? null,
        avatar: du.avatar ?? null,
        role: access.role,
        inGuild: access.inGuild,
        rolesCheckedAt: new Date(),
      },
      update: {
        username: du.username,
        globalName: du.global_name ?? null,
        avatar: du.avatar ?? null,
        role: access.role,
        inGuild: access.inGuild,
        rolesCheckedAt: new Date(),
        lastLoginAt: new Date(),
      },
    });
    if (user.banned) return to("/?error=banned");
    const res = to(safeReturnTo(data.r));
    await createSession(res, user.id, req.headers.get("user-agent"));
    await audit(user.id, "auth.login", user.discordId, { inGuild: access.inGuild, role: access.role }, clientIp(req));
    return res;
  } catch (e) {
    console.error("oauth callback:", (e as Error).message);
    return to("/?error=oauth_failed");
  }
}
