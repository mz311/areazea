import { Prisma, type Channel, type Role, type Version } from "@prisma/client";
import semver from "semver";
import { prisma } from "./db";
import { HttpError } from "./api";
import { parseManifest, type Manifest } from "./manifest";
import { storage } from "./storage";

export const cleanVersion = (v: string): string | null => {
  const t = v.trim().replace(/^v/i, "");
  return semver.valid(t) === t ? t : null;
};

export const compareVersions = (a: string, b: string) => semver.rcompare(a, b);

export const num = (b: bigint | null | undefined) => (b == null ? null : Number(b));

export function serializeVersion<V extends Version>(v: V) {
  const { manifest: _m, ...rest } = v;
  return { ...rest, totalSize: Number(v.totalSize), archiveSize: num(v.archiveSize) };
}

export function getManifest(v: Pick<Version, "manifest">): Manifest {
  return parseManifest(v.manifest);
}

/** Version courante (cible du launcher) d'un canal. */
export const currentVersion = (channel: Channel = "STABLE") =>
  prisma.version.findFirst({ where: { channel, isCurrent: true, status: "PUBLISHED" } });

export async function listPublished(maxRole: Role | "ALL" = "ALL") {
  const rows = await prisma.version.findMany({
    where: { status: "PUBLISHED" },
    include: { changes: { orderBy: { position: "asc" } }, _count: { select: { downloads: true } } },
  });
  return rows.sort((a, b) => compareVersions(a.version, b.version));
}

/** Fait de `id` la version courante de son canal (publication ou rollback). */
export async function makeCurrent(id: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.version.findUnique({ where: { id } });
    if (!v) throw new HttpError(404, "Version introuvable", "not_found");
    if (v.status !== "PUBLISHED") throw new HttpError(409, "La version doit être publiée", "not_published");
    const previous = await tx.version.findFirst({ where: { channel: v.channel, isCurrent: true } });
    await tx.version.updateMany({ where: { channel: v.channel, isCurrent: true }, data: { isCurrent: false } });
    const updated = await tx.version.update({ where: { id }, data: { isCurrent: true } });
    return { version: updated, previous };
  });
}

export async function publish(id: string, makeItCurrent = true) {
  const v = await prisma.version.findUnique({ where: { id } });
  if (!v) throw new HttpError(404, "Version introuvable", "not_found");
  if (v.status === "PUBLISHED") throw new HttpError(409, "Déjà publiée", "already_published");
  await prisma.version.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
  if (makeItCurrent) await makeCurrent(id);
  return prisma.version.findUniqueOrThrow({ where: { id }, include: { changes: { orderBy: { position: "asc" } } } });
}

export async function deleteVersion(id: string) {
  const v = await prisma.version.findUnique({ where: { id } });
  if (!v) throw new HttpError(404, "Version introuvable", "not_found");
  if (v.isCurrent) throw new HttpError(409, "Impossible de supprimer la version courante : faites d'abord un rollback", "is_current");
  await prisma.version.delete({ where: { id } });
  if (v.archiveKey) await storage().delete(v.archiveKey).catch(() => undefined);
  return v;
}

export async function referencedHashes(): Promise<Set<string>> {
  const rows = await prisma.version.findMany({ select: { manifest: true } });
  const set = new Set<string>();
  for (const r of rows) for (const f of parseManifest(r.manifest).files) set.add(f.sha256);
  return set;
}

/** Supprime les blobs qu'aucun manifeste ne référence plus. */
export async function gcBlobs(dryRun: boolean) {
  const refs = await referencedHashes();
  const keys = await storage().list("blobs/");
  const orphans = keys.filter((k) => !refs.has(k.slice(k.lastIndexOf("/") + 1)));
  if (!dryRun) for (const k of orphans) await storage().delete(k);
  return { total: keys.length, orphans: orphans.length, deleted: dryRun ? 0 : orphans.length };
}

export const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
