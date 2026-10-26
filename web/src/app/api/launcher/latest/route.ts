import { z } from "zod";
import { route, HttpError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { assertCanDownload } from "@/lib/access";
import { assertNotMaintenance } from "@/lib/maintenance";
import { currentVersion, getManifest, historyBetween } from "@/lib/versions";
import { manifestDigest } from "@/lib/manifest";

export const runtime = "nodejs";

const query = z.object({
  channel: z.enum(["STABLE", "BETA"]).default("STABLE"),
  version: z.string().max(40).optional(),
  /** Version installée : renvoie les patch notes de toutes les versions intermédiaires. */
  from: z.string().max(40).optional(),
});

/**
 * Version cible pour le launcher (la version « courante » du canal, ou une version précise) avec son manifeste.
 * Après un rollback, la version courante est plus ancienne : le launcher se synchronise simplement dessus.
 */
export const GET = route({ auth: "bearer", rate: { name: "l-latest", limit: 60, windowMs: 60_000 } }, async ({ req, user }) => {
  const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  await assertNotMaintenance(user!);
  const v = q.version
    ? await prisma.version.findFirst({ where: { version: q.version.replace(/^v/i, ""), status: "PUBLISHED" } })
    : await currentVersion(q.channel);
  if (!v) throw new HttpError(404, "Aucune version disponible", "no_version");
  assertCanDownload(user!, v);
  const changes = await prisma.change.findMany({ where: { versionId: v.id }, orderBy: { position: "asc" } });
  const manifest = getManifest(v);
  const { relation, history } = await historyBetween(v, q.from ? q.from.replace(/^v/i, "") : null);
  return {
    version: v.version,
    channel: v.channel,
    title: v.title,
    summary: v.summary,
    publishedAt: v.publishedAt,
    totalSize: Number(v.totalSize),
    fileCount: v.fileCount,
    manifestSha256: manifestDigest(manifest),
    changes: changes.map((c) => ({ type: c.type, text: c.text })),
    relation,
    history,
    manifest,
  };
});
