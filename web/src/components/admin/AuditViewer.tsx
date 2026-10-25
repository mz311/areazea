"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatDateTime } from "@/lib/format";
import { Feedback } from "./Feedback";

interface L {
  id: string;
  action: string;
  target: string | null;
  meta: unknown;
  ip: string | null;
  createdAt: string;
  actor: string | null;
}

export function AuditViewer() {
  const [logs, setLogs] = useState<L[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ logs: L[]; pages: number }>(`/api/admin/audit?page=${page}`)
      .then((r) => {
        setLogs(r.logs);
        setPages(r.pages);
      })
      .catch((e) => setError(e.message));
  }, [page]);

  return (
    <div className="space-y-4">
      <Feedback error={error} />
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-zinc-500">
            <tr><th className="px-5 py-3">Date</th><th className="px-5 py-3">Acteur</th><th className="px-5 py-3">Action</th><th className="px-5 py-3">Cible</th><th className="px-5 py-3">Détails</th><th className="px-5 py-3">IP</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {logs.map((l) => (
              <tr key={l.id} className="align-top hover:bg-white/[0.03]">
                <td className="whitespace-nowrap px-5 py-2.5 text-zinc-400">{formatDateTime(l.createdAt)}</td>
                <td className="px-5 py-2.5 text-white">{l.actor ?? "—"}</td>
                <td className="px-5 py-2.5"><code className="rounded bg-neon-500/10 px-1.5 py-0.5 text-xs text-neon-300">{l.action}</code></td>
                <td className="px-5 py-2.5 text-zinc-300">{l.target ?? "—"}</td>
                <td className="max-w-[260px] truncate px-5 py-2.5 font-mono text-xs text-zinc-500" title={l.meta ? JSON.stringify(l.meta) : ""}>{l.meta ? JSON.stringify(l.meta) : ""}</td>
                <td className="px-5 py-2.5 text-xs text-zinc-500">{l.ip ?? ""}</td>
              </tr>
            ))}
            {logs.length === 0 && <tr><td colSpan={6} className="px-5 py-8 text-center text-zinc-500">Journal vide.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Précédent</button>
          <span className="text-zinc-400">Page {page} / {pages}</span>
          <button className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Suivant</button>
        </div>
      )}
    </div>
  );
}
