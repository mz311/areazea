"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Bell, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

const KEY = "fbm_seen_version";

/** Interroge l'API publique et notifie (toast + notification navigateur si autorisée) quand une nouvelle version sort. */
export function UpdateNotifier() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch("/api/public/latest", { cache: "no-store" });
        if (!r.ok) return;
        const v: string | undefined = (await r.json()).latest?.version;
        if (!v || stop) return;
        let seen: string | null = null;
        try {
          seen = localStorage.getItem(KEY);
        } catch {}
        if (seen === null) {
          // première visite : on mémorise sans notifier
          try {
            localStorage.setItem(KEY, v);
          } catch {}
        } else if (seen !== v) {
          setVersion(v);
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification(`Nouvelle version disponible : v${v}`, { body: "Ouvrez le site ou le launcher pour mettre à jour." });
          }
        }
      } catch {}
    };
    check();
    const id = setInterval(check, 60_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const dismiss = () => {
    try {
      if (version) localStorage.setItem(KEY, version);
    } catch {}
    setVersion(null);
  };

  return (
    <AnimatePresence>
      {version && (
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 40 }}
          className="fixed bottom-4 right-4 z-50 w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-neon-500/40 bg-ink-800/95 p-4 shadow-neon-lg backdrop-blur"
          role="status"
        >
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-neon-500/20 p-2 text-neon-300">
              <Bell size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-white">Nouvelle version disponible</p>
              <p className="text-sm text-zinc-400">La version v{version} vient d&apos;être publiée.</p>
              <div className="mt-3 flex gap-2">
                <Link href="/updates" onClick={dismiss} className="btn-primary btn-sm">
                  Voir les nouveautés
                </Link>
                {typeof Notification !== "undefined" && Notification.permission === "default" && (
                  <button className="btn-ghost btn-sm" onClick={() => Notification.requestPermission()}>
                    Activer les alertes
                  </button>
                )}
              </div>
            </div>
            <button onClick={dismiss} aria-label="Fermer" className="text-zinc-500 hover:text-white">
              <X size={16} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
