"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import { apiFetch } from "@/lib/client";
import { formatDateTime } from "@/lib/format";
import { Feedback } from "./Feedback";

interface U {
  id: string;
  discordId: string;
  name: string;
  username: string;
  avatar: string;
  role: string;
  roleOverride: string | null;
  effective: string;
  inGuild: boolean;
  banned: boolean;
  downloads: number;
  lastLoginAt: string;
}

export function UsersManager() {
  const [users, setUsers] = useState<U[]>([]);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await apiFetch<{ users: U[]; pages: number }>(`/api/admin/users?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    setUsers(r.users);
    setPages(r.pages);
  }, [page, q]);
  useEffect(() => {
    const t = setTimeout(() => load().catch((e) => setError(e.message)), 250);
    return () => clearTimeout(t);
  }, [load]);

  const patch = async (id: string, body: object) => {
    setError(null);
    try {
      await apiFetch(`/api/admin/users/${id}`, { method: "PATCH", json: body });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-3 text-zinc-500" />
        <input className="input pl-9" placeholder="Pseudo ou ID Discord…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      <Feedback error={error} />
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-zinc-500">
            <tr><th className="px-5 py-3">Utilisateur</th><th className="px-5 py-3">Rôle Discord</th><th className="px-5 py-3">Surcharge</th><th className="px-5 py-3">Statut</th><th className="px-5 py-3">DL</th><th className="px-5 py-3">Dernière connexion</th><th className="px-5 py-3 text-right">Action</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-white/[0.03]">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u.avatar} alt="" width={32} height={32} className="h-8 w-8 rounded-lg" />
                    <div><div className="font-medium text-white">{u.name}</div><div className="text-xs text-zinc-500">{u.discordId}</div></div>
                  </div>
                </td>
                <td className="px-5 py-3"><Badge kind={u.role} /></td>
                <td className="px-5 py-3">
                  <select className="input w-auto py-1.5 text-xs" value={u.roleOverride ?? ""} onChange={(e) => patch(u.id, { roleOverride: e.target.value || null })} aria-label={`Surcharge de rôle pour ${u.name}`}>
                    <option value="">Aucune</option><option value="MEMBER">Membre</option><option value="VIP">VIP</option><option value="DEVELOPER">Développeur</option><option value="ADMIN">Administrateur</option>
                  </select>
                </td>
                <td className="px-5 py-3"><span className="flex flex-wrap gap-1">
                  {u.banned ? <Badge kind="ADMIN">Banni</Badge> : u.inGuild ? <Badge kind="NEW">Dans le serveur</Badge> : <Badge kind="FIX">Hors serveur</Badge>}
                </span></td>
                <td className="px-5 py-3 text-zinc-400">{u.downloads}</td>
                <td className="px-5 py-3 text-zinc-400">{formatDateTime(u.lastLoginAt)}</td>
                <td className="px-5 py-3 text-right">
                  <button className={u.banned ? "btn-ghost btn-sm" : "btn-danger btn-sm"} onClick={() => confirm(u.banned ? `Débannir ${u.name} ?` : `Bannir ${u.name} ? Ses sessions et jetons launcher seront révoqués.`) && patch(u.id, { banned: !u.banned })}>
                    {u.banned ? "Débannir" : "Bannir"}
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={7} className="px-5 py-8 text-center text-zinc-500">Aucun utilisateur.</td></tr>}
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
