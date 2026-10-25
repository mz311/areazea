"use client";

import { KeyRound, Trash2 } from "lucide-react";
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

  const revoke = async (id: string) => {
    setError(null);
    const r = await fetch(`/api/account/tokens/${id}`, { method: "DELETE" });
    if (r.ok) setTokens((t) => t.filter((x) => x.id !== id));
    else setError((await r.json()).error ?? "Erreur");
  };

  return (
    <div>
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
