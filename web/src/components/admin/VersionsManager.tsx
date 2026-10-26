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
  kind: "FULL" | "PATCH";
  parent: string | null;
}

export function VersionsManager() {
  const [versions, setVersions] = useState<V[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [version, setVersion] = useState("");
  const [channel, setChannel] = useState("STABLE");
  const [minRole, setMinRole] = useState("");
  const [mode, setMode] = useState<"patch" | "full">("patch");
  const [parent, setParent] = useState("");
  const [deletes, setDeletes] = useState("");
  const [stripRoot, setStripRoot] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = (await apiFetch<{ versions: V[] }>("/api/admin/versions")).versions;
      setVersions(list);
      // première version : forcément une base complète
      if (!list.some((v) => v.status === "PUBLISHED")) {
        setMode("full");
        setStripRoot(true);
      }
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
      const qs = new URLSearchParams({ version, channel, mode, stripRoot: String(stripRoot) });
      if (minRole) qs.set("minRole", minRole);
      if (parent) qs.set("parent", parent);
      if (mode === "patch" && deletes.trim()) qs.set("deletes", deletes);
      const r = await uploadRaw<any>(`/api/admin/versions/upload?${qs}`, file, (p) => {
        setProgress(p);
        if (p >= 100) setProcessing(true);
      });
      const parts = [
        `v${r.version} importée en brouillon${r.parent ? ` (${r.kind === "PATCH" ? "patch sur" : "base complète après"} v${r.parent})` : ""}.`,
        r.diff.against
          ? `Changements : +${r.diff.added} ajouté(s), ~${r.diff.modified} modifié(s), −${r.diff.removed} supprimé(s) ; ${formatBytes(r.diff.downloadSize)} à télécharger pour un joueur à jour.`
          : `${r.fileCount} fichiers.`,
        r.migrations.length ? `SQL de cette version : ${r.migrations.map((m: { name: string }) => m.name).join(", ")}.` : "Pas de SQL dans cette version.",
        `ZIP complet prêt à lancer : ${formatBytes(r.archiveSize)} (${r.fileCount} fichiers).`,
      ];
      if (r.unmatchedDeletes.length) parts.push(`⚠ Suppressions sans effet (aucun fichier correspondant) : ${r.unmatchedDeletes.join(", ")}.`);
      setOk(parts.join(" "));
      setFile(null);
      setVersion("");
      setDeletes("");
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
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Type d'envoi">
          {([
            ["patch", "Patch : fichiers modifiés", "Seulement ce qui change (+ _sql/ et fbm-delete.txt). Le site l'ajoute à la version de base et reconstruit la base complète."],
            ["full", "Base complète", "Toute la base. À utiliser pour la première version ou pour repartir d'une archive entière."],
          ] as const).map(([m, title, text]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m);
                setStripRoot(m === "full");
              }}
              className={`rounded-xl border p-4 text-left transition ${mode === m ? "border-neon-500 bg-neon-500/10" : "border-white/10 bg-white/[0.02] hover:border-white/25"}`}
            >
              <div className="font-semibold text-white">{title}</div>
              <div className="mt-1 text-xs text-zinc-400">{text}</div>
            </button>
          ))}
        </div>
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
          <div>
            <label className="label" htmlFor="pv">Version de base</label>
            <select id="pv" className="input" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">Version courante du canal</option>
              {versions.filter((v) => v.status === "PUBLISHED").map((v) => (
                <option key={v.id} value={v.version}>v{v.version}{v.isCurrent ? " (courante)" : ""}</option>
              ))}
            </select>
          </div>
        </div>
        {mode === "patch" && (
          <div>
            <label className="label" htmlFor="del">Fichiers ou dossiers à supprimer (un par ligne, optionnel)</label>
            <textarea id="del" className="input min-h-[72px] font-mono text-xs" placeholder={"resources/ancien-script\nresources/core/vieux.lua\n**/*.bak"} value={deletes} onChange={(e) => setDeletes(e.target.value)} />
          </div>
        )}
        <details className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-zinc-400">
          <summary className="cursor-pointer text-zinc-300">Comment préparer l&apos;archive ?</summary>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>Mettez les fichiers à leur emplacement dans la base : <code>server.cfg</code>, <code>resources/mon-script/client.lua</code>…</li>
            <li><strong className="text-zinc-200">SQL</strong> : placez les fichiers <code>.sql</code> de cette version dans un dossier <code>_sql/</code> (ex. <code>_sql/001_garage.sql</code>). Ils sont exécutés une seule fois sur chaque serveur par <code>fbm update</code>, dans l&apos;ordre des noms, et ajoutés à <code>sql/install.sql</code> pour les nouvelles installations.</li>
            <li><strong className="text-zinc-200">Suppressions</strong> (patch) : listez-les ci-dessus ou dans un fichier <code>fbm-delete.txt</code> à la racine du ZIP.</li>
            <li>Le ZIP téléchargé par les joueurs est toujours la base complète à jour, avec <code>sql/install.sql</code> (toute la base de données) et le <code>server.cfg</code>.</li>
          </ul>
          <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={stripRoot} onChange={(e) => setStripRoot(e.target.checked)} className="h-4 w-4 accent-violet-500" />
            L&apos;archive contient un seul dossier englobant (ex. <code>ma-base/</code>) : le retirer
          </label>
        </details>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center transition hover:border-neon-500/60">
          <FileArchive className="text-neon-300" />
          <span className="text-sm text-zinc-300">{file ? `${file.name} — ${formatBytes(file.size)}` : mode === "patch" ? "Choisir le ZIP du patch (fichiers modifiés)" : "Choisir l'archive ZIP de la base complète"}</span>
          <input ref={input} type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {progress !== null && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-zinc-400">
              <span>{processing ? "Validation, fusion et reconstruction de la base complète…" : "Envoi…"}</span><span>{progress}%</span>
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
                  {v.kind === "PATCH" && <Badge kind="NEWS">Patch{v.parent ? ` · v${v.parent}` : ""}</Badge>}
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
