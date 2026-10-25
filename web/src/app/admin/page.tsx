import type { Metadata } from "next";
import { BarChart } from "@/components/BarChart";
import { GcButton } from "@/components/admin/GcButton";
import { Badge, PageHeader, Stat } from "@/components/ui";
import { getAdminStats } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Administration" };

export default async function AdminDashboard() {
  const s = await getAdminStats();
  return (
    <div className="space-y-8">
      <PageHeader title="Tableau de bord" subtitle="Vue d'ensemble de la plateforme." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Téléchargements" value={s.totalDownloads.toLocaleString("fr-FR")} />
        <Stat label="Utilisateurs" value={s.users.toLocaleString("fr-FR")} hint={`${s.activeUsers30d} actifs (30 j)`} />
        <Stat label="Versions publiées" value={s.publishedVersions} />
        <Stat label="Rôles" value={Object.values(s.byRole).reduce((a, b) => a + b, 0)} hint={Object.entries(s.byRole).map(([r, n]) => `${r} ${n}`).join(" · ")} />
      </div>
      <div className="card p-6">
        <h2 className="mb-4 font-bold text-white">Téléchargements — 30 derniers jours</h2>
        <BarChart data={s.downloadsPerDay} />
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-zinc-500">
            <tr><th className="px-5 py-3">Version</th><th className="px-5 py-3">ZIP</th><th className="px-5 py-3">Installations</th><th className="px-5 py-3">Mises à jour</th><th className="px-5 py-3">Réparations</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {s.perVersion.map((v) => (
              <tr key={v.version}>
                <td className="px-5 py-3 font-bold text-white">v{v.version} {v.isCurrent && <Badge kind="CURRENT" />}</td>
                <td className="px-5 py-3">{v.zip}</td><td className="px-5 py-3">{v.install}</td><td className="px-5 py-3">{v.update}</td><td className="px-5 py-3">{v.repair}</td>
              </tr>
            ))}
            {s.perVersion.length === 0 && <tr><td colSpan={5} className="px-5 py-8 text-center text-zinc-500">Aucune donnée.</td></tr>}
          </tbody>
        </table>
      </div>
      <GcButton />
    </div>
  );
}
