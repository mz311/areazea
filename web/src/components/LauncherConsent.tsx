"use client";

import { Loader2, MonitorCheck } from "lucide-react";
import { useState } from "react";

export function LauncherConsent({ port, state, user }: { port: number; state: string; user: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const authorize = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Launcher Windows", port, state }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Erreur");
      setDone(true);
      window.location.href = j.redirect; // http://127.0.0.1:<port>/callback?token=…
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="card mx-auto max-w-md p-8 text-center shadow-neon">
      <div className="mx-auto mb-5 inline-flex rounded-2xl bg-neon-500/15 p-4 text-neon-300"><MonitorCheck size={32} /></div>
      <h1 className="text-2xl font-extrabold text-white">Autoriser le launcher ?</h1>
      <p className="mt-3 text-sm text-zinc-400">
        Le launcher installé sur votre PC demande l&apos;accès à votre compte <strong className="text-white">{user}</strong> pour télécharger la base selon vos rôles Discord.
      </p>
      {done ? (
        <p className="mt-6 text-emerald-300">Autorisation envoyée. Vous pouvez fermer cet onglet et revenir au launcher.</p>
      ) : (
        <button onClick={authorize} disabled={busy} className="btn-primary mt-6 w-full">
          {busy && <Loader2 size={16} className="animate-spin" />} Autoriser
        </button>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <p className="mt-5 text-xs text-zinc-600">Vous pourrez révoquer cet accès à tout moment depuis « Mon compte ».</p>
    </div>
  );
}
