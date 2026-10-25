"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { Feedback } from "./Feedback";

export function GcButton() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (dryRun: boolean) => {
    setErr(null);
    setMsg(null);
    try {
      const r = await apiFetch<{ total: number; orphans: number; deleted: number }>("/api/admin/storage/gc", { method: "POST", json: { dryRun } });
      setMsg(dryRun ? `${r.orphans} fichier(s) orphelin(s) sur ${r.total} stockés.` : `${r.deleted} fichier(s) supprimé(s).`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card flex flex-wrap items-center gap-3 p-5">
      <div className="mr-auto">
        <h2 className="font-bold text-white">Nettoyage du stockage</h2>
        <p className="text-sm text-zinc-500">Supprime les fichiers qu&apos;aucune version ne référence plus (brouillons supprimés…).</p>
      </div>
      <button className="btn-ghost btn-sm" onClick={() => run(true)}>Analyser</button>
      <button className="btn-danger btn-sm" onClick={() => confirm("Supprimer définitivement les fichiers orphelins ?") && run(false)}><Trash2 size={14} /> Nettoyer</button>
      <div className="w-full"><Feedback error={err} ok={msg} /></div>
    </div>
  );
}
