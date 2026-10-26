import { Database, FileDiff } from "lucide-react";
import type { DiffSummary } from "@/lib/release";
import { formatBytes } from "@/lib/format";

export interface SqlFile {
  name: string;
  size: number;
  /** Contenu (si le visiteur a accès à la version), éventuellement tronqué. */
  content: string | null;
  truncated: boolean;
}

function FileList({ title, items, total, tone }: { title: string; items: string[]; total: number; tone: string }) {
  if (!total) return null;
  const shown = items.slice(0, 40);
  return (
    <div className="min-w-0">
      <div className={`mb-1 text-xs font-semibold uppercase tracking-wider ${tone}`}>{title} ({total})</div>
      <ul className="max-h-48 space-y-0.5 overflow-auto font-mono text-xs text-zinc-400">
        {shown.map((p) => (
          <li key={p} className="truncate" title={p}>{p}</li>
        ))}
        {total > shown.length && <li className="text-zinc-500">… et {total - shown.length} autre(s)</li>}
      </ul>
    </div>
  );
}

/** Patch notes techniques : fichiers touchés, ressources, SQL exécuté par « fbm update ». */
export function TechDetails({ summary, sql }: { summary: DiffSummary | null; sql: SqlFile[] }) {
  if (!summary) return null;
  const { counts } = summary;
  const nothing = !counts.added && !counts.modified && !counts.removed && !sql.length;
  if (nothing) return null;
  return (
    <details className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-300">
        <span className="flex items-center gap-1.5 font-semibold text-white"><FileDiff size={15} className="text-neon-300" /> Détails techniques</span>
        <span className="text-emerald-300">+{counts.added}</span>
        <span className="text-amber-300">~{counts.modified}</span>
        <span className="text-red-300">−{counts.removed}</span>
        {sql.length > 0 && <span className="flex items-center gap-1 text-sky-300"><Database size={13} /> {sql.length} fichier(s) SQL</span>}
      </summary>
      <div className="mt-4 space-y-5">
        {summary.resources.length > 0 && (
          <p className="text-sm text-zinc-400">
            Ressources concernées : {summary.resources.map((r) => <code key={r} className="mr-1.5 rounded bg-white/5 px-1.5 py-0.5 text-xs text-zinc-200">{r}</code>)}
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          <FileList title="Ajoutés" items={summary.added} total={counts.added} tone="text-emerald-300" />
          <FileList title="Modifiés" items={summary.modified} total={counts.modified} tone="text-amber-300" />
          <FileList title="Supprimés" items={summary.removed} total={counts.removed} tone="text-red-300" />
        </div>
        {sql.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-sky-300">SQL (exécuté automatiquement par « fbm update », déjà inclus dans sql/install.sql)</div>
            {sql.map((f) => (
              <details key={f.name} className="rounded-lg border border-white/10 bg-ink-900/60">
                <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-zinc-200">
                  {f.name} <span className="text-zinc-500">· {formatBytes(f.size)}</span>
                </summary>
                {f.content !== null ? (
                  <pre className="max-h-80 overflow-auto border-t border-white/10 p-3 text-xs leading-relaxed text-zinc-300">{f.content}{f.truncated ? "\n-- … (tronqué : voir le fichier dans le ZIP)" : ""}</pre>
                ) : (
                  <p className="border-t border-white/10 px-3 py-2 text-xs text-zinc-500">Connectez-vous avec un compte ayant accès à cette version pour voir le contenu.</p>
                )}
              </details>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
