import { Readable } from "node:stream";
import { prisma } from "@/lib/db";
import { mediaKey, storage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = /^[a-z0-9]{10,40}$/.test(id) ? await prisma.mediaAsset.findUnique({ where: { id } }) : null;
  if (!asset) return new Response("Introuvable", { status: 404 });
  const obj = await storage().get(mediaKey(asset.id));
  return new Response(Readable.toWeb(obj.stream as Readable) as ReadableStream, {
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(obj.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
