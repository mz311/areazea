import { z } from "zod";
import { route, readJson } from "@/lib/api";
import { prisma } from "@/lib/db";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const MAX_ACTIVE = 10;

export const GET = route({ auth: "session" }, async ({ user }) => {
  const tokens = await prisma.launcherToken.findMany({
    where: { userId: user!.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true },
  });
  return { tokens };
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(60).default("Launcher"),
  /** Flux « loopback » : le launcher écoute sur 127.0.0.1:<port> pour recevoir le jeton. */
  port: z.number().int().min(1024).max(65535).optional(),
  state: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
});

export const POST = route({ auth: "session", rate: { name: "tok-create", limit: 10, windowMs: 3600_000 } }, async ({ req, user, ip }) => {
  const body = await readJson(req, createSchema);
  const token = `fvl_${randomToken(32)}`;
  const active = await prisma.launcherToken.findMany({ where: { userId: user!.id, revokedAt: null }, orderBy: { createdAt: "asc" } });
  if (active.length >= MAX_ACTIVE) {
    await prisma.launcherToken.updateMany({
      where: { id: { in: active.slice(0, active.length - MAX_ACTIVE + 1).map((t) => t.id) } },
      data: { revokedAt: new Date() },
    });
  }
  const row = await prisma.launcherToken.create({ data: { tokenHash: sha256Hex(token), userId: user!.id, name: body.name } });
  await audit(user!.id, "launcher.token.create", row.id, { name: body.name }, ip);
  const redirect = body.port
    ? `http://127.0.0.1:${body.port}/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(body.state ?? "")}`
    : null;
  // Le jeton n'est renvoyé qu'une seule fois : seul son hash est stocké.
  return { id: row.id, token, redirect };
});
