import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { env } from "./env";
import { sha256Hex } from "./crypto";
import { hasRole } from "./rbac";
import { rateLimit } from "./rate-limit";
import { getSessionUser, refreshMembership, withEffective, type AuthUser } from "./auth/session";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const clientIp = (req: Request): string => {
  const h = req.headers;
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",").pop()!.trim();
  return "unknown";
};

type AuthMode = "none" | "session" | "bearer" | "either";

export interface RouteCtx<P> {
  req: NextRequest;
  params: P;
  user: AuthUser | null;
  via: "session" | "bearer" | null;
  ip: string;
}

export interface RouteOptions {
  auth?: AuthMode;
  minRole?: Role;
  /** Limite par IP (anonyme) ou par utilisateur (authentifié). */
  rate?: { limit: number; windowMs: number; name: string };
}

async function bearerUser(req: Request): Promise<AuthUser | null> {
  const m = /^Bearer (fvl_[A-Za-z0-9_-]{20,})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const token = await prisma.launcherToken.findUnique({ where: { tokenHash: sha256Hex(m[1]) }, include: { user: true } });
  if (!token || token.revokedAt || token.user.banned) return null;
  if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > 60_000) {
    await prisma.launcherToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
  }
  return withEffective(await refreshMembership(token.user));
}

/** Vérifie l'origine pour les requêtes modifiantes authentifiées par cookie (CSRF). */
function checkOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  const appHost = new URL(env().APP_URL).host;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== appHost) throw new HttpError(403, "Origine non autorisée", "bad_origin");
    return;
  }
  if (req.headers.get("sec-fetch-site") === "same-origin") return;
  throw new HttpError(403, "Origine manquante", "bad_origin");
}

export function route<P = Record<string, never>>(
  opts: RouteOptions,
  handler: (ctx: RouteCtx<P>) => Promise<Response | object | void>,
) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const ip = clientIp(req);
    try {
      let user: AuthUser | null = null;
      let via: "session" | "bearer" | null = null;
      const mode = opts.auth ?? "none";
      if (mode === "bearer" || mode === "either") {
        user = await bearerUser(req);
        if (user) via = "bearer";
      }
      if (!user && (mode === "session" || mode === "either")) {
        user = await getSessionUser();
        if (user) via = "session";
      }
      if (mode !== "none" && !user) throw new HttpError(401, "Authentification requise", "unauthenticated");
      if (via === "session" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) checkOrigin(req);
      if (opts.minRole && (!user || !hasRole(user.effective, opts.minRole))) {
        throw new HttpError(403, "Permissions insuffisantes", "forbidden");
      }
      if (opts.rate) {
        const key = `${opts.rate.name}:${user ? "u" + user.id : "ip" + ip}`;
        const r = rateLimit(key, opts.rate.limit, opts.rate.windowMs);
        if (!r.ok) throw new HttpError(429, "Trop de requêtes", "rate_limited", { "Retry-After": String(r.retryAfter) });
      }
      const out = await handler({ req, params: await segment.params, user, via, ip });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      if (e instanceof HttpError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: e.status, headers: e.headers });
      }
      if (e instanceof ZodError) {
        return NextResponse.json(
          { error: "Données invalides", code: "invalid", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
          { status: 400 },
        );
      }
      console.error(`[${req.method} ${req.nextUrl.pathname}]`, e);
      return NextResponse.json({ error: "Erreur interne", code: "internal" }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request, schema: { parse: (v: unknown) => T }): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Corps JSON invalide", "invalid_json");
  }
  return schema.parse(body);
}
