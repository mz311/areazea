"use client";

import { ArrowDown, ArrowUp, ImagePlus, Loader2, Plus, Rocket, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge, Stat } from "@/components/ui";
import { apiFetch, uploadRaw } from "@/lib/client";
import { formatBytes, formatDate } from "@/lib/format";
import { Feedback } from "./Feedback";

type ChangeType = "NEW" | "FIX" | "IMPROVEMENT";
interface Change {
  type: ChangeType;
  text: string;
  imageId: string | null;
}

interface Detail {
  version: {
    id: string;
    version: string;
    status: "DRAFT" | "PUBLISHED";
    channel: "STABLE" | "BETA";
    isCurrent: boolean;
    minRole: string;
    title: string | null;
    summary: string | null;
    fileCount: number;
    totalSize: number;
    archiveSize: number | null;
    archiveSha256: string | null;
    publishedAt: string | null;
    changes: Change[];
  };
  manifest: { managedDirs: string[]; protected: string[]; files: { path: string; sha256: string; size: number }[]; truncated: boolean };
  diff: { against: string | null; added: number; modified: number; removed: number; downloadSize: number };
}

export function VersionEditor({ id }: { id: string }) {
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [minRole, setMinRole] = useState("MEMBER");
  const [channel, setChannel] = useState("STABLE");
  const [changes, setChanges] = useState<Change[]>([]);
  const [prot, setProt] = useState("");
  const [dirs, setDirs] = useState("");
  const [makeCurrent, setMakeCurrent] = useState(true);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<Detail>(`/api/admin/versions/${id}`);
      setD(r);
      setTitle(r.version.title ?? "");
      setSummary(r.version.summary ?? "");
      setMinRole(r.version.minRole);
      setChannel(r.version.channel);
      setChanges(r.version.changes.map((c) => ({ type: c.type, text: c.text, imageId: c.imageId ?? null })));
      setProt(r.manifest.protected.join("\n"));
      setDirs(r.manifest.managedDirs.join("\n"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (!d) return error ? <Feedback error={error} /> : <p className="text-zinc-500">Chargement…</p>;
  const v = d.version;
  const draft = v.status === "DRAFT";
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

  const run = async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(label);
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(label);
      after ? after() : await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("Modifications enregistrées.", () =>
      apiFetch(`/api/admin/versions/${id}`, {
        method: "PUT",
        json: {
          title: title || null,
          summary: summary || null,
          minRole,
          changes: changes.filter((c) => c.text.trim()),
          ...(draft ? { channel, protected: lines(prot), managedDirs: lines(dirs) } : {}),
        },
      }),
    );

  const publish = async () => {
    if (!confirm(`Publier v${v.version}${makeCurrent ? " et la définir comme version courante" : ""} ?`)) return;
    await run("Version publiée.", async () => {
      await apiFetch(`/api/admin/versions/${id}`, {
        method: "PUT",
        json: { title: title || null, summary: summary || null, minRole, changes: changes.filter((c) => c.text.trim()), channel, protected: lines(prot), managedDirs: lines(dirs) },
      });
      const r = await apiFetch<{ discordNotified: boolean }>(`/api/admin/versions/${id}/publish`, { method: "POST", json: { makeCurrent, notifyDiscord: notify } });
      setOk(`Version publiée.${notify ? (r.discordNotified ? " Annonce Discord envoyée." : " Annonce Discord non envoyée (webhook non configuré ou en erreur).") : ""}`);
    });
  };

  const setChange = (i: number, patch: Partial<Change>) => setChanges((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, dir: -1 | 1) =>
    setChanges((cs) => {
      const j = i + dir;
      if (j < 0 || j >= cs.length) return cs;
      const n = [...cs];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  const uploadImage = async (i: number, f: File) => {
    setError(null);
    try {
      const r = await uploadRaw<{ id: string }>("/api/admin/media", f, () => undefined, f.type || "application/octet-stream");
      setChange(i, { imageId: r.id });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const files = d.manifest.files.filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin/versions" className="text-sm text-zinc-500 hover:text-white">← Versions</Link>
        <h1 className="gradient-text text-3xl font-extrabold">v{v.version}</h1>
        {draft ? <Badge kind="DRAFT" /> : v.isCurrent ? <Badge kind="CURRENT" /> : <Badge kind="MEMBER">Publiée</Badge>}
        {v.channel === "BETA" && <Badge kind="BETA" />}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Fichiers" value={v.fileCount.toLocaleString("fr-FR")} />
        <Stat label="Taille" value={formatBytes(v.totalSize)} hint={`ZIP : ${formatBytes(v.archiveSize ?? 0)}`} />
        <Stat label={d.diff.against ? `Changements vs v${d.diff.against}` : "Changements"} value={`+${d.diff.added} ~${d.diff.modified} −${d.diff.removed}`} />
        <Stat label="À télécharger (launcher)" value={formatBytes(d.diff.downloadSize)} hint="mise à jour différentielle" />
      </div>
      {v.archiveSha256 && <p className="break-all text-xs text-zinc-500">SHA-256 du ZIP : <code className="text-neon-300">{v.archiveSha256}</code></p>}

      <Feedback error={error} ok={ok} />

      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-extrabold text-white">Informations</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="t">Titre</label>
            <input id="t" className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Mise à jour garage & économie" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="s">Résumé</label>
            <textarea id="s" className="input min-h-[80px]" value={summary} maxLength={2000} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="mr">Rôle minimum</label>
            <select id="mr" className="input" value={minRole} onChange={(e) => setMinRole(e.target.value)}>
              <option value="MEMBER">Membre</option><option value="VIP">VIP</option><option value="DEVELOPER">Développeur</option><option value="ADMIN">Administrateur</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ch">Canal</label>
            <select id="ch" className="input" value={channel} disabled={!draft} onChange={(e) => setChannel(e.target.value)}>
              <option value="STABLE">Stable</option><option value="BETA">Bêta</option>
            </select>
          </div>
        </div>
      </section>

      <section className="card space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-white">Changelog</h2>
          <button className="btn-ghost btn-sm" onClick={() => setChanges((c) => [...c, { type: "NEW", text: "", imageId: null }])}><Plus size={14} /> Ajouter</button>
        </div>
        {changes.length === 0 && <p className="text-sm text-zinc-500">Aucune entrée. Ajoutez des nouveautés (NEW), corrections (FIX) ou améliorations (IMPROVEMENT).</p>}
        <ul className="space-y-3">
          {changes.map((c, i) => (
            <li key={i} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-start gap-2">
                <select className="input w-auto" value={c.type} onChange={(e) => setChange(i, { type: e.target.value as ChangeType })} aria-label="Type">
                  <option value="NEW">NEW</option><option value="FIX">FIX</option><option value="IMPROVEMENT">IMPROVEMENT</option>
                </select>
                <input className="input min-w-[200px] flex-1" value={c.text} maxLength={500} placeholder="Description du changement" onChange={(e) => setChange(i, { text: e.target.value })} />
                <label className="btn-ghost btn-sm cursor-pointer" title="Ajouter une image">
                  <ImagePlus size={14} />
                  <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && uploadImage(i, e.target.files[0])} />
                </label>
                <button className="btn-ghost btn-sm" onClick={() => move(i, -1)} aria-label="Monter"><ArrowUp size={14} /></button>
                <button className="btn-ghost btn-sm" onClick={() => move(i, 1)} aria-label="Descendre"><ArrowDown size={14} /></button>
                <button className="btn-danger btn-sm" onClick={() => setChanges((cs) => cs.filter((_, j) => j !== i))} aria-label="Supprimer"><Trash2 size={14} /></button>
              </div>
              {c.imageId && (
                <div className="mt-3 flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/${c.imageId}`} alt="" className="max-h-28 rounded-lg border border-white/10" />
                  <button className="text-xs text-red-300 hover:underline" onClick={() => setChange(i, { imageId: null })}>Retirer l&apos;image</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {draft && (
        <section className="card space-y-4 p-6">
          <h2 className="text-lg font-extrabold text-white">Règles du launcher</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="label" htmlFor="p">Fichiers protégés (motifs glob, un par ligne)</label>
              <textarea id="p" className="input min-h-[150px] font-mono text-xs" value={prot} onChange={(e) => setProt(e.target.value)} />
              <p className="mt-1 text-xs text-zinc-500">Jamais écrasés ni supprimés s&apos;ils existent déjà chez le joueur (ex. <code>server.cfg</code>, <code>**/config.lua</code>).</p>
            </div>
            <div>
              <label className="label" htmlFor="d">Dossiers gérés (un par ligne)</label>
              <textarea id="d" className="input min-h-[150px] font-mono text-xs" value={dirs} onChange={(e) => setDirs(e.target.value)} />
              <p className="mt-1 text-xs text-zinc-500">Seuls les anciens fichiers <em>installés par le launcher</em> dans ces dossiers peuvent être supprimés.</p>
            </div>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-ghost" onClick={save} disabled={!!busy}>{busy === "Modifications enregistrées." ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Enregistrer</button>
        {draft && (
          <>
            <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-violet-500" checked={makeCurrent} onChange={(e) => setMakeCurrent(e.target.checked)} /> Définir comme version courante</label>
            <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-violet-500" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Annoncer sur Discord</label>
            <button className="btn-primary ml-auto" onClick={publish} disabled={!!busy}><Rocket size={16} /> Publier</button>
          </>
        )}
        {!draft && !v.isCurrent && (
          <button className="btn-primary ml-auto" onClick={() => confirm(`Définir v${v.version} comme version courante ?`) && run(`v${v.version} est maintenant la version courante.`, () => apiFetch(`/api/admin/versions/${id}/rollback`, { method: "POST" }))}>
            Définir comme version courante (rollback)
          </button>
        )}
        {draft && <button className="btn-danger" onClick={() => confirm("Supprimer ce brouillon ?") && run("Brouillon supprimé.", () => apiFetch(`/api/admin/versions/${id}`, { method: "DELETE" }), () => router.push("/admin/versions"))}>Supprimer</button>}
      </div>
      {!draft && <p className="text-xs text-zinc-500">Publiée le {formatDate(v.publishedAt)}.</p>}

      <section className="card p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold text-white">Manifeste ({v.fileCount.toLocaleString("fr-FR")} fichiers)</h2>
          <input className="input max-w-xs" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="max-h-96 overflow-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-ink-800 text-zinc-500"><tr><th className="px-3 py-2">Chemin</th><th className="px-3 py-2">Taille</th><th className="px-3 py-2">SHA-256</th></tr></thead>
            <tbody className="divide-y divide-white/5 font-mono">
              {files.slice(0, 500).map((f) => (
                <tr key={f.path}><td className="px-3 py-1.5 text-zinc-300">{f.path}</td><td className="px-3 py-1.5 text-zinc-500">{formatBytes(f.size)}</td><td className="px-3 py-1.5 text-zinc-600" title={f.sha256}>{f.sha256.slice(0, 16)}…</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {(files.length > 500 || d.manifest.truncated) && <p className="mt-2 text-xs text-zinc-500">Aperçu limité aux premiers fichiers.</p>}
      </section>
    </div>
  );
}
