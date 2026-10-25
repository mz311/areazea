"use client";

import { Megaphone, Pin, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import { apiFetch } from "@/lib/client";
import { formatDateTime } from "@/lib/format";
import { Feedback } from "./Feedback";

interface A {
  id: string;
  kind: "NEWS" | "MAINTENANCE" | "NEW_RESOURCE";
  title: string;
  body: string;
  pinned: boolean;
  discordSent: boolean;
  createdAt: string;
}

export function AnnouncementsManager() {
  const [items, setItems] = useState<A[]>([]);
  const [kind, setKind] = useState("NEWS");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [discord, setDiscord] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => setItems((await apiFetch<{ announcements: A[] }>("/api/admin/announcements")).announcements), []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOk(null);
    try {
      const r = await apiFetch<{ discordNotified: boolean }>("/api/admin/announcements", { method: "POST", json: { kind, title, body, pinned, sendToDiscord: discord } });
      setOk(discord ? (r.discordNotified ? "Annonce publiée et envoyée sur Discord." : "Annonce publiée (Discord non envoyé : webhook absent ou en erreur).") : "Annonce publiée.");
      setTitle("");
      setBody("");
      setPinned(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const del = async (id: string) => {
    if (!confirm("Supprimer cette annonce ?")) return;
    await apiFetch(`/api/admin/announcements/${id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    await load();
  };
  const togglePin = async (a: A) => {
    await apiFetch(`/api/admin/announcements/${a.id}`, { method: "PUT", json: { pinned: !a.pinned } }).catch((e) => setError(e.message));
    await load();
  };

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="card space-y-4 p-6">
        <h2 className="flex items-center gap-2 text-lg font-extrabold text-white"><Megaphone size={18} className="text-neon-300" /> Nouvelle annonce</h2>
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <div>
            <label className="label" htmlFor="k">Type</label>
            <select id="k" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="NEWS">Actualité</option><option value="MAINTENANCE">Maintenance</option><option value="NEW_RESOURCE">Nouvelle ressource</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="at">Titre</label>
            <input id="at" className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="ab">Message</label>
          <textarea id="ab" className="input min-h-[110px]" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} required />
        </div>
        <div className="flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-violet-500" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Épingler</label>
          <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-violet-500" checked={discord} onChange={(e) => setDiscord(e.target.checked)} /> Envoyer aussi sur Discord</label>
          <button className="btn-primary ml-auto">Publier</button>
        </div>
      </form>
      <Feedback error={error} ok={ok} />
      <ul className="space-y-3">
        {items.map((a) => (
          <li key={a.id} className="card flex flex-wrap items-start gap-4 p-5">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge kind={a.kind} />
                <h3 className="font-bold text-white">{a.title}</h3>
                {a.pinned && <Pin size={14} className="text-neon-300" />}
                {a.discordSent && <span className="text-xs text-zinc-500">· envoyé sur Discord</span>}
              </div>
              <p className="whitespace-pre-line text-sm text-zinc-400">{a.body}</p>
              <p className="mt-2 text-xs text-zinc-600">{formatDateTime(a.createdAt)}</p>
            </div>
            <div className="flex gap-2">
              <button className="btn-ghost btn-sm" onClick={() => togglePin(a)}><Pin size={14} /> {a.pinned ? "Détacher" : "Épingler"}</button>
              <button className="btn-danger btn-sm" onClick={() => del(a.id)}><Trash2 size={14} /></button>
            </div>
          </li>
        ))}
        {items.length === 0 && <li className="card p-8 text-center text-zinc-500">Aucune annonce.</li>}
      </ul>
    </div>
  );
}
