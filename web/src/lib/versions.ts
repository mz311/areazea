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
  const children = await prisma.version.findMany({ where: { parentId: id }, select: { version: true } });
  if (children.length) {
    throw new HttpError(409, `Des versions sont construites sur celle-ci (${children.map((c) => "v" + c.version).join(", ")}) : supprimez-les d'abord`, "has_children");
  }
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

/** Historique d'une version : de la première version (racine) jusqu'à elle, en suivant les parents. */
export async function chainOf(id: string) {
  const out = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const v: Prisma.VersionGetPayload<{ include: { changes: true } }> | null = await prisma.version.findUnique({
      where: { id: cur },
      include: { changes: { orderBy: { position: "asc" } } },
    });
    if (!v) break;
    out.unshift(v);
    cur = v.parentId;
  }
  return out;
}

export interface HistoryEntry {
  version: string;
  title: string | null;
  summary: string | null;
  publishedAt: Date | null;
  changes: { type: string; text: string }[];
  sql: string[];
  counts: { added: number; modified: number; removed: number } | null;
}

/**
 * Patch notes entre la version installée (`from`, exclue) et `target` (incluse).
 * relation : "upgrade" (from est un ancêtre), "same", "downgrade" (target est un ancêtre de from) ou "unrelated".
 */
export async function historyBetween(target: { id: string; version: string }, from: string | null) {
  const chain = await chainOf(target.id);
  const entry = (v: (typeof chain)[number]): HistoryEntry => {
    const d = v.diffSummary as { counts?: HistoryEntry["counts"]; migrations?: { name: string }[] } | null;
    return {
      version: v.version,
      title: v.title,
      summary: v.summary,
      publishedAt: v.publishedAt,
      changes: v.changes.map((c) => ({ type: c.type, text: c.text })),
      sql: (d?.migrations ?? []).map((m) => m.name),
      counts: d?.counts ?? null,
    };
  };
  const published = chain.filter((v) => v.status === "PUBLISHED");
  if (!from) return { relation: "install" as const, history: published.slice(-1).map(entry) };
  if (from === target.version) return { relation: "same" as const, history: [] };
  const idx = chain.findIndex((v) => v.version === from);
  if (idx >= 0) return { relation: "upgrade" as const, history: chain.slice(idx + 1).filter((v) => v.status === "PUBLISHED").map(entry) };
  const fromRow = await prisma.version.findUnique({ where: { version: from } });
  if (fromRow && (await chainOf(fromRow.id)).some((v) => v.id === target.id)) return { relation: "downgrade" as const, history: [] };
  return { relation: "unrelated" as const, history: [] };
}
