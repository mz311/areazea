import clsx from "clsx";
import type { ReactNode } from "react";

const BADGES: Record<string, string> = {
  NEW: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30",
  FIX: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30",
  IMPROVEMENT: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/30",
  VIP: "bg-yellow-500/15 text-yellow-300 ring-1 ring-yellow-400/30",
  BETA: "bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-400/30",
  DEVELOPER: "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-400/30",
  ADMIN: "bg-red-500/15 text-red-300 ring-1 ring-red-400/30",
  MEMBER: "bg-zinc-500/15 text-zinc-300 ring-1 ring-zinc-400/20",
  CURRENT: "bg-neon-500/20 text-neon-300 ring-1 ring-neon-400/40",
  DRAFT: "bg-zinc-500/15 text-zinc-400 ring-1 ring-zinc-400/20",
  NEWS: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/30",
  MAINTENANCE: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30",
  NEW_RESOURCE: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30",
};

const LABELS: Record<string, string> = {
  CURRENT: "Actuelle",
  DRAFT: "Brouillon",
  NEWS: "Actu",
  MAINTENANCE: "Maintenance",
  NEW_RESOURCE: "Nouvelle ressource",
  MEMBER: "Membre",
  DEVELOPER: "Dév",
  ADMIN: "Admin",
};

export function Badge({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={clsx("badge", BADGES[kind] ?? BADGES.MEMBER)}>{children ?? LABELS[kind] ?? kind}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card p-5">
      <div className="text-xs uppercase tracking-wider text-zinc-400">{label}</div>
      <div className="mt-1 text-3xl font-extrabold text-white">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="gradient-text text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 max-w-2xl text-zinc-400">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
