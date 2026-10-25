"use client";

import { CheckCircle2, XCircle } from "lucide-react";

export function Feedback({ error, ok }: { error?: string | null; ok?: string | null }) {
  if (!error && !ok) return null;
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm ${error ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`} role="status">
      {error ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
      {error ?? ok}
    </div>
  );
}
