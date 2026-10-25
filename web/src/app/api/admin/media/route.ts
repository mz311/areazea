import { randomBytes } from "node:crypto";
import { route, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sniffImage } from "@/lib/image";
import { mediaKey, storage } from "@/lib/storage";

export const runtime = "nodejs";

const MAX = 5 * 1024 * 1024;

export const POST = route({ auth: "session", minRole: "ADMIN", rate: { name: "media", limit: 60, windowMs: 3600_000 } }, async ({ req, user, ip }) => {
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) throw new HttpError(400, "Fichier vide", "empty");
  if (buf.length > MAX) throw new HttpError(413, "Image trop volumineuse (max 5 Mo)", "too_large");
  const mime = sniffImage(buf);
  if (!mime) throw new HttpError(415, "Format non supporté (PNG, JPEG, GIF ou WebP)", "bad_type");
  const id = randomBytes(12).toString("hex");
  await storage().putBuffer(mediaKey(id), buf, mime);
  await prisma.mediaAsset.create({ data: { id, key: mediaKey(id), mime, size: buf.length, createdById: user!.id } });
  await audit(user!.id, "media.upload", id, { mime, size: buf.length }, ip);
  return { id, url: `/api/media/${id}` };
});
