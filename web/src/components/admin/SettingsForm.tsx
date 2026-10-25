"use client";

import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client";
import type { SiteSettings } from "@/lib/settings";
import { Feedback } from "./Feedback";

export function SettingsForm() {
  const [s, setS] = useState<SiteSettings | null>(null);
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ settings: SiteSettings }>("/api/admin/settings").then((r) => setS(r.settings)).catch((e) => setError(e.message));
  }, []);
  if (!s) return <Feedback error={error} />;

  const set = <K extends keyof SiteSettings>(k: K, v: SiteSettings[K]) => setS({ ...s, [k]: v });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOk(null);
    try {
      const r = await apiFetch<{ discordNotified: boolean }>("/api/admin/settings", { method: "PUT", json: { ...s, notifyDiscord: notify } });
      setOk("Paramètres enregistrés." + (r.discordNotified ? " Notification de maintenance envoyée sur Discord." : ""));
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form onSubmit={save} className="space-y-6">
      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-extrabold text-white">Identité du site</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label className="label" htmlFor="sn">Nom</label><input id="sn" className="input" value={s.siteName} maxLength={60} onChange={(e) => set("siteName", e.target.value)} required /></div>
          <div><label className="label" htmlFor="lg">URL du logo</label><input id="lg" className="input" value={s.logoUrl} placeholder="https://… ou /api/media/…" onChange={(e) => set("logoUrl", e.target.value)} /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="tg">Slogan</label><input id="tg" className="input" value={s.tagline} maxLength={200} onChange={(e) => set("tagline", e.target.value)} /></div>
          <div><label className="label" htmlFor="di">Invitation Discord</label><input id="di" className="input" value={s.discordInviteUrl} placeholder="https://discord.gg/…" onChange={(e) => set("discordInviteUrl", e.target.value)} /></div>
          <div><label className="label" htmlFor="ld">URL de téléchargement du launcher</label><input id="ld" className="input" value={s.launcherDownloadUrl} placeholder="https://…/Launcher-Setup.exe" onChange={(e) => set("launcherDownloadUrl", e.target.value)} /></div>
        </div>
      </section>
      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-extrabold text-white">Maintenance</h2>
        <label className="flex items-center gap-3 text-sm text-zinc-200">
          <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={s.maintenance.enabled} onChange={(e) => set("maintenance", { ...s.maintenance, enabled: e.target.checked })} />
          Activer le mode maintenance (téléchargements et launcher suspendus, sauf administrateurs)
        </label>
        <div><label className="label" htmlFor="mm">Message affiché</label><input id="mm" className="input" value={s.maintenance.message} maxLength={500} onChange={(e) => set("maintenance", { ...s.maintenance, message: e.target.value })} /></div>
        <label className="flex items-center gap-3 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-violet-500" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notifier Discord si l&apos;état de maintenance change</label>
      </section>
      <Feedback error={error} ok={ok} />
      <button className="btn-primary"><Save size={16} /> Enregistrer</button>
    </form>
  );
}
