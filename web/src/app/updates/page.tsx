import type { Metadata } from "next";
import { ChangeList } from "@/components/ChangeList";
import { Reveal } from "@/components/Reveal";
import { Badge, PageHeader } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { formatBytes, formatDate } from "@/lib/format";
import { visibleVersions } from "@/lib/visible";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Mises à jour" };

export default async function UpdatesPage() {
  const user = await getSessionUser();
  const versions = await visibleVersions(user);
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
              </article>
            </Reveal>
          </li>
        ))}
      </ol>
    </div>
  );
}
