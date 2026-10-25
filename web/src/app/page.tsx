import { ArrowRight, Download, FileCheck2, GitCompareArrows, Rocket, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import { ChangeList } from "@/components/ChangeList";
import { Logo } from "@/components/Logo";
import { Reveal } from "@/components/Reveal";
import { Badge, Stat } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { formatBytes, formatDate, timeAgo } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { getServiceStatus } from "@/lib/status";
import { currentVersion } from "@/lib/versions";
import { visibleVersions } from "@/lib/visible";

export const dynamic = "force-dynamic";

const STATE_STYLE = {
  operational: ["bg-emerald-400", "Opérationnel"],
  degraded: ["bg-amber-400", "Dégradé"],
  down: ["bg-red-500", "Hors ligne"],
  maintenance: ["bg-amber-400", "Maintenance"],
} as const;

const FEATURES = [
  { icon: GitCompareArrows, title: "Mises à jour différentielles", text: "Le launcher ne télécharge que les fichiers nouveaux ou modifiés." },
  { icon: FileCheck2, title: "Intégrité SHA-256", text: "Chaque fichier est vérifié avant d'être installé, avec restauration automatique en cas d'échec." },
  { icon: ShieldCheck, title: "Accès par rôles Discord", text: "Membre, VIP, développeur, administrateur : les téléchargements suivent vos rôles." },
  { icon: Rocket, title: "Vos configs protégées", text: "server.cfg et vos fichiers de configuration ne sont jamais écrasés." },
];

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const user = await getSessionUser();
  const [settings, latest, downloads, services, announcements, versions] = await Promise.all([
    getSettings(),
    currentVersion("STABLE"),
    prisma.download.count({ where: { kind: { in: ["ZIP", "INSTALL"] } } }),
    getServiceStatus().catch(() => []),
    prisma.announcement.findMany({ orderBy: [{ pinned: "desc" }, { createdAt: "desc" }], take: 4 }),
    visibleVersions(user),
  ]);
  const recent = versions.slice(0, 3);

  const ERRORS: Record<string, string> = {
    cancelled: "Connexion annulée.",
    oauth_state: "Session de connexion expirée, réessayez.",
    oauth_failed: "La connexion Discord a échoué, réessayez.",
    banned: "Ce compte est banni.",
  };

  return (
    <div className="space-y-24">
      {error && ERRORS[error] && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{ERRORS[error]}</div>}

      <section className="relative pt-6 text-center">
        <Reveal>
          <div className="mx-auto mb-6 w-fit animate-float rounded-3xl p-1 shadow-neon-lg">
            <Logo logoUrl={settings.logoUrl} size={84} />
          </div>
          {latest && (
            <Link href="/updates" className="mx-auto mb-5 flex w-fit items-center gap-2 rounded-full border border-neon-500/40 bg-neon-500/10 px-4 py-1.5 text-xs font-semibold text-neon-300 transition hover:bg-neon-500/20">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-neon-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-neon-400" />
              </span>
              Dernière version : v{latest.version}
              <ArrowRight size={12} />
            </Link>
          )}
          <h1 className="mx-auto max-w-4xl text-4xl font-black tracking-tight sm:text-6xl">
            <span className="gradient-text">{settings.siteName}</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-400">{settings.tagline}</p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/download" className="btn-primary px-7 py-3 text-base">
              <Download size={18} /> Télécharger la base
            </Link>
            {settings.discordInviteUrl && (
              <a href={settings.discordInviteUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost px-7 py-3 text-base">
                <Users size={18} /> Rejoindre notre Discord
              </a>
            )}
          </div>
        </Reveal>
      </section>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Reveal><Stat label="Version actuelle" value={latest ? `v${latest.version}` : "—"} hint={latest ? formatDate(latest.publishedAt) : "Aucune publication"} /></Reveal>
        <Reveal delay={0.05}><Stat label="Téléchargements" value={downloads.toLocaleString("fr-FR")} hint="Installations & ZIP" /></Reveal>
        <Reveal delay={0.1}><Stat label="Taille" value={latest ? formatBytes(Number(latest.totalSize)) : "—"} hint="Base complète" /></Reveal>
        <Reveal delay={0.15}><Stat label="Fichiers" value={latest ? latest.fileCount.toLocaleString("fr-FR") : "—"} hint="Vérifiés SHA-256" /></Reveal>
      </section>

      <section>
        <Reveal><h2 className="mb-8 text-center text-2xl font-extrabold text-white sm:text-3xl">Pourquoi cette plateforme ?</h2></Reveal>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={i * 0.06}>
              <div className="card card-hover h-full p-6">
                <div className="mb-4 inline-flex rounded-xl bg-neon-500/15 p-3 text-neon-300"><f.icon size={22} /></div>
                <h3 className="font-bold text-white">{f.title}</h3>
                <p className="mt-2 text-sm text-zinc-400">{f.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Reveal><h2 className="text-2xl font-extrabold text-white">Dernières mises à jour</h2></Reveal>
          {recent.length === 0 && <p className="card p-6 text-zinc-500">Aucune version publiée pour le moment.</p>}
          {recent.map((v, i) => (
            <Reveal key={v.id} delay={i * 0.05}>
              <div className="card card-hover p-6">
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <h3 className="text-xl font-extrabold text-white">v{v.version}</h3>
                  {v.isCurrent && <Badge kind="CURRENT" />}
                  {v.minRole !== "MEMBER" && <Badge kind={v.minRole} />}
                  {v.channel === "BETA" && <Badge kind="BETA" />}
                  <span className="text-sm text-zinc-500">{formatDate(v.publishedAt)}</span>
                </div>
                {v.title && <p className="mb-3 font-medium text-zinc-200">{v.title}</p>}
                <ChangeList changes={v.changes.slice(0, 4)} />
                {v.changes.length > 4 && (
                  <Link href={`/updates#v${v.version}`} className="mt-4 inline-flex items-center gap-1 text-sm text-neon-300 hover:underline">
                    Voir les {v.changes.length} changements <ArrowRight size={14} />
                  </Link>
                )}
              </div>
            </Reveal>
          ))}

          {announcements.length > 0 && (
            <>
              <Reveal><h2 className="pt-6 text-2xl font-extrabold text-white">Actualités</h2></Reveal>
              {announcements.map((a) => (
                <Reveal key={a.id}>
                  <div className={`card p-5 ${a.pinned ? "border-neon-500/40" : ""}`}>
                    <div className="mb-2 flex items-center gap-3">
                      <Badge kind={a.kind} />
                      <h3 className="font-bold text-white">{a.title}</h3>
                      <span className="ml-auto text-xs text-zinc-500">{timeAgo(a.createdAt)}</span>
                    </div>
                    <p className="whitespace-pre-line text-sm text-zinc-300">{a.body}</p>
                  </div>
                </Reveal>
              ))}
            </>
          )}
        </div>

        <aside>
          <Reveal>
            <div className="card sticky top-24 p-6">
              <h2 className="mb-4 text-lg font-extrabold text-white">Statut des services</h2>
              <ul className="space-y-3">
                {services.map((s) => {
                  const [dot, label] = STATE_STYLE[s.state];
                  return (
                    <li key={s.id} className="flex items-center justify-between text-sm">
                      <span className="text-zinc-300">{s.name}</span>
                      <span className="flex items-center gap-2 text-zinc-400">
                        <span className={`h-2.5 w-2.5 rounded-full ${dot} shadow-[0_0_8px_currentColor]`} />
                        {label}
                      </span>
                    </li>
                  );
                })}
                {services.length === 0 && <li className="text-sm text-zinc-500">Statut indisponible.</li>}
              </ul>
            </div>
          </Reveal>
        </aside>
      </section>
    </div>
  );
}
