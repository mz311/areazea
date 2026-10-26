import { AlertTriangle, Copy, Download, LogIn, MonitorDown, Server, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DownloadButton } from "@/components/DownloadButton";
import { Reveal } from "@/components/Reveal";
import { Badge, PageHeader } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { formatBytes, formatDate } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { currentVersion } from "@/lib/versions";
import { visibleVersions } from "@/lib/visible";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Téléchargement" };

export default async function DownloadPage() {
  const [user, settings] = await Promise.all([getSessionUser(), getSettings()]);
  const [latest, versions] = await Promise.all([currentVersion("STABLE"), visibleVersions(user)]);
  const canAccess = !!user && user.inGuild && !user.banned;
  const maintenance = settings.maintenance.enabled && user?.effective !== "ADMIN";

  return (
    <div className="space-y-10">
      <PageHeader title="Téléchargement" subtitle="Installez la base avec le launcher (recommandé, mises à jour automatiques) ou téléchargez l'archive ZIP." />

      {!user && (
        <Reveal>
          <div className="card flex flex-col items-start gap-4 border-neon-500/30 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">Connectez-vous avec Discord</h2>
              <p className="text-sm text-zinc-400">Les téléchargements sont réservés aux membres de notre serveur Discord.</p>
            </div>
            <a href="/api/auth/discord/login?returnTo=/download" className="btn-primary">
              <LogIn size={16} /> Connexion Discord
            </a>
          </div>
        </Reveal>
      )}

      {user && !user.inGuild && (
        <Reveal>
          <div className="card flex flex-col gap-4 border-amber-500/30 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 text-amber-300" />
              <div>
                <h2 className="font-bold text-white">Vous n&apos;êtes pas (ou pas encore vérifié) sur notre serveur Discord</h2>
                <p className="text-sm text-zinc-400">Rejoignez le serveur, puis reconnectez-vous pour débloquer les téléchargements.</p>
              </div>
            </div>
            {settings.discordInviteUrl && (
              <a href={settings.discordInviteUrl} className="btn-primary" target="_blank" rel="noopener noreferrer">
                <Users size={16} /> Rejoindre le Discord
              </a>
            )}
          </div>
        </Reveal>
      )}

      {maintenance && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Les téléchargements sont suspendus pendant la maintenance.
        </div>
      )}

      {latest ? (
        <Reveal>
          <div className="card relative overflow-hidden border-neon-500/30 p-8 shadow-neon">
            <div className="absolute -right-20 -top-20 h-60 w-60 rounded-full bg-neon-600/20 blur-3xl" />
            <div className="relative grid gap-8 md:grid-cols-2">
              <div>
                <div className="mb-3 flex items-center gap-3">
                  <Badge kind="CURRENT" />
                  <span className="text-sm text-zinc-500">Version stable</span>
                </div>
                <h2 className="text-5xl font-black text-white">v{latest.version}</h2>
                {latest.title && <p className="mt-2 text-zinc-300">{latest.title}</p>}
                <dl className="mt-6 grid grid-cols-3 gap-4 text-sm">
                  <div><dt className="text-zinc-500">Poids (ZIP)</dt><dd className="font-semibold text-white">{formatBytes(Number(latest.archiveSize ?? 0))}</dd></div>
                  <div><dt className="text-zinc-500">Publiée le</dt><dd className="font-semibold text-white">{formatDate(latest.publishedAt)}</dd></div>
                  <div><dt className="text-zinc-500">Fichiers</dt><dd className="font-semibold text-white">{latest.fileCount.toLocaleString("fr-FR")}</dd></div>
                </dl>
                {latest.archiveSha256 && (
                  <div className="mt-5">
                    <div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wider text-zinc-500"><Copy size={12} /> SHA-256 du ZIP</div>
                    <code className="block break-all rounded-lg bg-ink-900 px-3 py-2 text-xs text-neon-300">{latest.archiveSha256}</code>
                  </div>
                )}
              </div>
              <div className="flex flex-col justify-center gap-4">
                {canAccess && !maintenance ? (
                  <>
                    <DownloadButton version={latest.version} label={`Télécharger v${latest.version} (ZIP)`} />
                    {settings.launcherDownloadUrl && (
                      <a href={settings.launcherDownloadUrl} className="btn-ghost" rel="noopener noreferrer">
                        <MonitorDown size={16} /> Télécharger le launcher Windows
                      </a>
                    )}
                    <p className="text-xs text-zinc-500">Le lien de téléchargement est temporaire et signé. Vérifiez le SHA-256 après téléchargement :<br /><code className="text-zinc-400">certutil -hashfile fichier.zip SHA256</code></p>
                  </>
                ) : (
                  <p className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-400">
                    <Download className="mb-2 inline" size={16} /> Connectez-vous et rejoignez le serveur Discord pour télécharger.
                  </p>
                )}
              </div>
            </div>
          </div>
        </Reveal>
      ) : (
        <p className="card p-8 text-center text-zinc-500">Aucune version stable n&apos;a encore été publiée.</p>
      )}

      <Reveal>
        <section className="card p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="rounded-xl bg-neon-500/15 p-2.5 text-neon-300"><Server size={20} /></div>
            <div>
              <h2 className="text-lg font-extrabold text-white">Mettre à jour depuis txAdmin</h2>
              <p className="text-sm text-zinc-400">Sur votre serveur, sans launcher : une commande dans la console txAdmin ou en jeu.</p>
            </div>
          </div>
          <ol className="grid gap-4 text-sm text-zinc-300 md:grid-cols-3">
            <li className="min-w-0">
              <span className="font-semibold text-white">1. Créez un jeton</span> sur{" "}
              <Link href="/account" className="text-neon-300 hover:underline">Mon compte</Link> (« Créer un jeton »).
            </li>
            <li className="min-w-0">
              <span className="font-semibold text-white">2. Dans server.cfg</span>, avant vos autres ressources :
              <code className="mt-2 block overflow-x-auto whitespace-pre rounded-lg bg-ink-900 px-3 py-2 text-xs text-neon-300">{`set fbm_api "${env().APP_URL}"
set fbm_token "fvl_…"
ensure fbm-updater   # avant les autres ensure`}</code>
            </li>
            <li className="min-w-0">
              <span className="font-semibold text-white">3. Tapez</span> <code className="text-neon-300">fbm update</code> dans la console txAdmin (ou{" "}
              <code className="text-neon-300">/fbm update</code> en jeu), puis <span className="font-semibold text-white">redémarrez le serveur</span> : la mise à jour s&apos;applique au démarrage.
            </li>
          </ol>
          <p className="mt-4 text-xs text-zinc-500">
            Seuls les fichiers modifiés sont téléchargés et vérifiés (SHA-256) ; votre server.cfg et vos fichiers de configuration ne sont jamais écrasés.
            En jeu, la commande demande la permission <code>command.fbm</code> (ex. <code>add_ace group.admin command.fbm allow</code>).
          </p>
        </section>
      </Reveal>

      <section>
        <h2 className="mb-4 text-xl font-extrabold text-white">Historique des versions</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-5 py-3">Version</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Poids</th>
                <th className="px-5 py-3">SHA-256</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {versions.map((v) => (
                <tr key={v.id} className="transition hover:bg-white/[0.03]">
                  <td className="px-5 py-3">
                    <Link href={`/updates#v${v.version}`} className="font-bold text-white hover:text-neon-300">v{v.version}</Link>
                    <span className="ml-2 inline-flex gap-1">
                      {v.isCurrent && <Badge kind="CURRENT" />}
                      {v.channel === "BETA" && <Badge kind="BETA" />}
                      {v.minRole !== "MEMBER" && <Badge kind={v.minRole} />}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-zinc-400">{formatDate(v.publishedAt)}</td>
                  <td className="px-5 py-3 text-zinc-400">{formatBytes(Number(v.archiveSize ?? 0))}</td>
                  <td className="px-5 py-3"><code className="text-xs text-zinc-500" title={v.archiveSha256 ?? ""}>{v.archiveSha256?.slice(0, 16)}…</code></td>
                  <td className="px-5 py-3 text-right">
                    {canAccess && !maintenance && <DownloadButton version={v.version} label="ZIP" small />}
                  </td>
                </tr>
              ))}
              {versions.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-zinc-500">Aucune version.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
