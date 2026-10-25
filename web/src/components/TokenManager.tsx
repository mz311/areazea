"use client";

import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatDateTime } from "@/lib/format";

interface Tok {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function TokenManager({ initial }: { initial: Tok[] }) {
  const [tokens, setTokens] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await fetch("/api/account/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() || "Jeton CLI" }),
    });
    const j = await r.json();
    if (!r.ok) return setError(j.error ?? "Erreur");
    setCreated(j.token); // affiché une seule fois : seul son hash est conservé côté serveur
    setName("");
    const list = await fetch("/api/account/tokens").then((x) => x.json());
    setTokens(list.tokens);
  };

  const revoke = async (id: string) => {
    setError(null);
    const r = await fetch(`/api/account/tokens/${id}`, { method: "DELETE" });
    if (r.ok) setTokens((t) => t.filter((x) => x.id !== id));
    else setError((await r.json()).error ?? "Erreur");
  };

  return (
    <div>
      <form onSubmit={create} className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label className="label" htmlFor="tn">Nouveau jeton (pour la CLI / un serveur)</label>
          <input id="tn" className="input" placeholder="Ex. Serveur de test" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn-ghost"><Plus size={14} /> Créer un jeton</button>
      </form>
      {created && (
        <div className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="mb-2 text-sm text-emerald-200">Copiez ce jeton maintenant : il ne sera <strong>plus jamais affiché</strong>.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-ink-900 px-3 py-2 text-xs text-neon-300">{created}</code>
            <button className="btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(created)} type="button"><Copy size={14} /> Copier</button>
          </div>
        </div>
      )}
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <ul className="divide-y divide-white/5">
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center gap-4 py-3">
            <KeyRound size={18} className="text-neon-300" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-white">{t.name}</div>
              <div className="text-xs text-zinc-500">
                Créé le {formatDateTime(t.createdAt)} · Dernière utilisation : {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "jamais"}
              </div>
            </div>
            <button onClick={() => revoke(t.id)} className="btn-danger btn-sm">
              <Trash2 size={14} /> Révoquer
            </button>
          </li>
        ))}
        {tokens.length === 0 && <li className="py-6 text-center text-sm text-zinc-500">Aucun launcher connecté.</li>}
      </ul>
    </div>
  );
}
