import type { Metadata } from "next";
import { ChangeList } from "@/components/ChangeList";
import { TechDetails, type SqlFile } from "@/components/TechDetails";
import { Reveal } from "@/components/Reveal";
import { Badge, PageHeader } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { formatBytes, formatDate } from "@/lib/format";
import { parseManifest } from "@/lib/manifest";
import type { DiffSummary } from "@/lib/release";
import { blobKey, storage } from "@/lib/storage";
import { visibleVersions } from "@/lib/visible";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Mises à jour" };

const SQL_PREVIEW = 64 * 1024;

async function readSql(sha256: string, size: number): Promise<{ content: string | null; truncated: boolean }> {
  try {
    const obj = await storage().get(blobKey(sha256));
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of obj.stream) {
      chunks.push(c as Buffer);
      n += (c as Buffer).length;
      if (n >= SQL_PREVIEW) break;
    }
    obj.stream.destroy();
    return { content: Buffer.concat(chunks).subarray(0, SQL_PREVIEW).toString("utf8"), truncated: size > SQL_PREVIEW };
  } catch {
    return { content: null, truncated: false };
  }
}

export default async function UpdatesPage() {
  const user = await getSessionUser();
  const versions = await visibleVersions(user);
  // le contenu SQL n'est montré qu'aux comptes qui ont accès aux téléchargements (anonymes : noms seulement)
  const canSee = !!user && user.inGuild && !user.banned;
  const sqlByVersion = new Map<string, SqlFile[]>();
  for (const v of versions) {
    const own = (parseManifest(v.manifest).migrations ?? []).filter((m) => m.version === v.version);
    sqlByVersion.set(
      v.id,
      await Promise.all(own.map(async (m) => ({ name: m.name, size: m.size, ...(canSee ? await readSql(m.sha256, m.size) : { content: null, truncated: false }) }))),
    );
  }
  return (
    <div>
      <PageHeader title="Mises à jour" subtitle="Toutes les versions de la base, de la plus récente à la plus ancienne." />
      {versions.length === 0 && <p className="card p-8 text-center text-zinc-500">Aucune version publiée pour le moment.</p>}
      <ol className="relative space-y-8 border-l border-neon-500/30 pl-6 sm:pl-10">
        {versions.map((v, i) => (
          <li key={v.id} id={`v${v.version}`} className="relative scroll-mt-24">
            <span className="absolute -left-[31px] top-6 h-3 w-3 rounded-full border-2 border-neon-400 bg-ink-950 shadow-neon sm:-left-[47px]" />
            <Reveal delay={Math.min(i, 5) * 0.04}>
              <article className="card p-6">
                <header className="mb-4 flex flex-wrap items-center gap-3">
                  <h2 className="text-2xl font-extrabold text-white">v{v.version}</h2>
                  {v.isCurrent && <Badge kind="CURRENT" />}
                  {v.channel === "BETA" && <Badge kind="BETA" />}
                  {v.minRole !== "MEMBER" && <Badge kind={v.minRole} />}
                  <span className="text-sm text-zinc-500">
                    {formatDate(v.publishedAt)} · {formatBytes(Number(v.totalSize))} · {v.fileCount.toLocaleString("fr-FR")} fichiers
                  </span>
                </header>
                {v.title && <p className="mb-1 text-lg font-semibold text-zinc-100">{v.title}</p>}
                {v.summary && <p className="mb-4 whitespace-pre-line text-zinc-400">{v.summary}</p>}
                <ChangeList changes={v.changes} />
                <TechDetails summary={v.diffSummary as DiffSummary | null} sql={sqlByVersion.get(v.id) ?? []} />
              </article>
            </Reveal>
          </li>
        ))}
      </ol>
    </div>
  );
}
