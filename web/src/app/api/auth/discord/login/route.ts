import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { authorizeUrl } from "@/lib/auth/discord";
import { cookieOptions, OAUTH_COOKIE } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { randomToken, signPayload } from "@/lib/crypto";
import { clientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { safeReturnTo } from "@/lib/redirect";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const rl = rateLimit(`login:${clientIp(req)}`, 30, 10 * 60_000);
  if (!rl.ok) return new NextResponse("Trop de tentatives, réessayez plus tard.", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get("returnTo"));

  const res = NextResponse.redirect(authorizeUrl(state, challenge));
  res.cookies.set(OAUTH_COOKIE, signPayload(env().APP_SECRET, { s: state, v: verifier, r: returnTo }, 600), {
    ...cookieOptions(600),
    sameSite: "lax",
  });
  return res;
}
