"use client";

import { Download, Loader2 } from "lucide-react";
import { useState } from "react";

export function DownloadButton({ version, label = "Télécharger le ZIP", small, disabled }: { version: string; label?: string; small?: boolean; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/download/${encodeURIComponent(version)}/link`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Erreur");
      window.location.href = j.url; // lien temporaire signé
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button onClick={go} disabled={busy || disabled} className={small ? "btn-primary btn-sm" : "btn-primary"}>
        {busy ? <Loader2 size={small ? 14 : 16} className="animate-spin" /> : <Download size={small ? 14 : 16} />}
        {label}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
