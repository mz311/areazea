import { NextRequest } from "next/server";
import { Readable } from "node:stream";
import { clientIp } from "@/lib/api";
import { env } from "@/lib/env";
import { verifyPayload } from "@/lib/crypto";
import { rateLimit } from "@/lib/rate-limit";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";

/** Téléchargement via lien HMAC temporaire (driver de stockage local). Avec S3, les liens sont présignés par le bucket. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rl = rateLimit(`files:${clientIp(req)}`, 6000, 60_000);
  if (!rl.ok) return new Response("Trop de requêtes", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const { token } = await params;
  const data = verifyPayload<{ k: string; f?: string; t?: string }>(env().APP_SECRET, token);
  if (!data) return new Response("Lien invalide ou expiré", { status: 403 });
  try {
    const obj = await storage().get(data.k);
    const headers = new Headers({
      "Content-Type": data.t ?? "application/octet-stream",
      "Content-Length": String(obj.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (data.f) headers.set("Content-Disposition", `attachment; filename="${data.f.replace(/[^\w.\-]/g, "_")}"`);
    return new Response(Readable.toWeb(obj.stream as Readable) as ReadableStream, { headers });
  } catch {
    return new Response("Introuvable", { status: 404 });
  }
}
