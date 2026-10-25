"use client";

import { FileArchive, Loader2, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui";
import { apiFetch, uploadRaw } from "@/lib/client";
import { formatBytes, formatDate } from "@/lib/format";
import { Feedback } from "./Feedback";

interface V {
  id: string;
  version: string;
  channel: "STABLE" | "BETA";
  status: "DRAFT" | "PUBLISHED";
  isCurrent: boolean;
  minRole: string;
  fileCount: number;
  totalSize: number;
  archiveSize: number | null;
  publishedAt: string | null;
  createdAt: string;
  downloads: number;
  changeCount: number;
}

export function VersionsManager() {
  const [versions, setVersions] = useState<V[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [version, setVersion] = useState("");
  const [channel, setChannel] = useState("STABLE");
  const [minRole, setMinRole] = useState("");
  const [stripRoot, setStripRoot] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setVersions((await apiFetch<{ versions: V[] }>("/api/admin/versions")).versions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setOk(null);
    setProgress(0);
    try {
      const qs = new URLSearchParams({ version, channel, stripRoot: String(stripRoot) });
      if (minRole) qs.set("minRole", minRole);
      const r = await uploadRaw<any>(`/api/admin/versions/upload?${qs}`, file, (p) => {
        setProgress(p);
        if (p >= 100) setProcessing(true);
      });
      setOk(
        `v${r.version} importée : ${r.fileCount} fichiers (${formatBytes(r.totalSize)}). ` +
          (r.diff.against ? `Par rapport à v${r.diff.against} : +${r.diff.added} / ~${r.diff.modified} / −${r.diff.removed}, ${formatBytes(r.diff.downloadSize)} à télécharger pour les joueurs.` : "Première version."),
      );
      setFile(null);
      setVersion("");
      if (input.current) input.current.value = "";
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
      setProcessing(false);
    }
  };

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(label);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="card space-y-5 p-6">
        <h2 className="flex items-center gap-2 text-lg font-extrabold text-white"><Upload size={18} className="text-neon-300" /> Nouvelle version</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="v">Numéro</label>
            <input id="v" className="input" placeholder="1.2.0" value={version} onChange={(e) => setVersion(e.target.value)} required pattern="v?\d+\.\d+\.\d+([-+].+)?" />
          </div>
          <div>
            <label className="label" htmlFor="c">Canal</label>
            <select id="c" className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="STABLE">Stable</option>
              <option value="BETA">Bêta</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="r">Rôle minimum</label>
            <select id="r" className="input" value={minRole} onChange={(e) => setMinRole(e.target.value)}>
              <option value="">Par défaut du canal</option>
              <option value="MEMBER">Membre</option>
              <option value="VIP">VIP</option>
              <option value="DEVELOPER">Développeur</option>
              <option value="ADMIN">Administrateur</option>
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={stripRoot} onChange={(e) => setStripRoot(e.target.checked)} className="h-4 w-4 accent-violet-500" />
              Retirer le dossier racine unique
            </label>
          </div>
        </div>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center transition hover:border-neon-500/60">
          <FileArchive className="text-neon-300" />
          <span className="text-sm text-zinc-300">{file ? `${file.name} — ${formatBytes(file.size)}` : "Choisir l'archive ZIP de la base"}</span>
          <input ref={input} type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {progress !== null && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-zinc-400">
              <span>{processing ? "Validation de l'archive et calcul des SHA-256…" : "Envoi…"}</span><span>{progress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className={`h-full rounded-full bg-gradient-to-r from-neon-600 to-neon-400 transition-all ${processing ? "animate-pulse" : ""}`} style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={!file || !version || progress !== null}>
            {progress !== null && <Loader2 size={16} className="animate-spin" />} Importer en brouillon
          </button>
          <span className="text-xs text-zinc-500">L&apos;archive est analysée (chemins, extensions, taille) avant d&apos;être acceptée.</span>
        </div>
      </form>

      <Feedback error={error} ok={ok} />

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-zinc-500">
            <tr><th className="px-5 py-3">Version</th><th className="px-5 py-3">État</th><th className="px-5 py-3">Fichiers</th><th className="px-5 py-3">Taille</th><th className="px-5 py-3">DL</th><th className="px-5 py-3">Date</th><th className="px-5 py-3 text-right">Actions</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading && <tr><td colSpan={7} className="px-5 py-8 text-center text-zinc-500">Chargement…</td></tr>}
            {versions.map((v) => (
              <tr key={v.id} className="hover:bg-white/[0.03]">
                <td className="px-5 py-3 font-bold text-white">v{v.version}</td>
                <td className="px-5 py-3"><span className="flex flex-wrap gap-1">
                  {v.status === "DRAFT" ? <Badge kind="DRAFT" /> : v.isCurrent ? <Badge kind="CURRENT" /> : <Badge kind="MEMBER">Publiée</Badge>}
                  {v.channel === "BETA" && <Badge kind="BETA" />}
                  {v.minRole !== "MEMBER" && <Badge kind={v.minRole} />}
                </span></td>
                <td className="px-5 py-3 text-zinc-400">{v.fileCount.toLocaleString("fr-FR")}</td>
                <td className="px-5 py-3 text-zinc-400">{formatBytes(v.totalSize)}</td>
                <td className="px-5 py-3 text-zinc-400">{v.downloads}</td>
                <td className="px-5 py-3 text-zinc-400">{formatDate(v.publishedAt ?? v.createdAt)}</td>
                <td className="px-5 py-3">
                  <div className="flex justify-end gap-2">
                    <Link href={`/admin/versions/${v.id}`} className="btn-ghost btn-sm">{v.status === "DRAFT" ? "Éditer / publier" : "Détails"}</Link>
                    {v.status === "PUBLISHED" && !v.isCurrent && (
                      <button className="btn-ghost btn-sm" onClick={() => confirm(`Définir v${v.version} comme version courante ? Les launchers se synchroniseront dessus.`) && act(`v${v.version} est maintenant la version courante.`, () => apiFetch(`/api/admin/versions/${v.id}/rollback`, { method: "POST" }))}>
                        Rollback
                      </button>
                    )}
                    {!v.isCurrent && (
                      <button className="btn-danger btn-sm" onClick={() => confirm(`Supprimer v${v.version} ?`) && act(`v${v.version} supprimée.`, () => apiFetch(`/api/admin/versions/${v.id}`, { method: "DELETE" }))}>
                        Supprimer
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!loading && versions.length === 0 && <tr><td colSpan={7} className="px-5 py-8 text-center text-zinc-500">Aucune version. Importez votre première archive ci-dessus.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
