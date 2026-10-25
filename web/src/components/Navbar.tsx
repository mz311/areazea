"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Download, LogIn, LogOut, Menu, Shield, User, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Logo } from "./Logo";

export interface NavUser {
  name: string;
  avatar: string;
  role: string;
}

const LINKS = [
  { href: "/", label: "Accueil" },
  { href: "/download", label: "Téléchargement" },
  { href: "/updates", label: "Mises à jour" },
];

export function Navbar({ siteName, logoUrl, user }: { siteName: string; logoUrl: string; user: NavUser | null }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };

  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-3" onClick={() => setOpen(false)}>
          <Logo logoUrl={logoUrl} size={34} />
          <span className="text-lg font-extrabold tracking-tight text-white">{siteName}</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`relative rounded-lg px-3.5 py-2 text-sm font-medium transition ${path === l.href ? "text-white" : "text-zinc-400 hover:text-white"}`}
            >
              {l.label}
              {path === l.href && <motion.span layoutId="nav-underline" className="absolute inset-x-3 -bottom-0.5 h-0.5 rounded bg-neon-500 shadow-neon" />}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          {user ? (
            <>
              {user.role === "ADMIN" && (
                <Link href="/admin" className="btn-ghost btn-sm">
                  <Shield size={14} /> Admin
                </Link>
              )}
              <Link href="/account" className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 py-1 pl-1 pr-3 transition hover:border-neon-500/50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={user.avatar} alt="" width={28} height={28} className="h-7 w-7 rounded-lg" />
                <span className="max-w-[120px] truncate text-sm font-medium text-white">{user.name}</span>
              </Link>
              <button onClick={logout} aria-label="Déconnexion" className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/5 hover:text-white">
                <LogOut size={16} />
              </button>
            </>
          ) : (
            <a href={`/api/auth/discord/login?returnTo=${encodeURIComponent(path || "/")}`} className="btn-primary btn-sm">
              <LogIn size={14} /> Connexion Discord
            </a>
          )}
        </div>

        <button className="rounded-lg p-2 text-zinc-300 md:hidden" onClick={() => setOpen((o) => !o)} aria-label="Menu">
          {open ? <X /> : <Menu />}
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-white/5 md:hidden"
          >
            <div className="flex flex-col gap-1 p-4">
              {LINKS.map((l) => (
                <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-lg px-3 py-2.5 text-zinc-200 hover:bg-white/5">
                  {l.label}
                </Link>
              ))}
              {user ? (
                <>
                  <Link href="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2.5 hover:bg-white/5">
                    <User size={16} /> {user.name}
                  </Link>
                  {user.role === "ADMIN" && (
                    <Link href="/admin" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2.5 hover:bg-white/5">
                      <Shield size={16} /> Administration
                    </Link>
                  )}
                  <button onClick={logout} className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-zinc-400 hover:bg-white/5">
                    <LogOut size={16} /> Déconnexion
                  </button>
                </>
              ) : (
                <a href="/api/auth/discord/login" className="btn-primary mt-2">
                  <LogIn size={16} /> Connexion Discord
                </a>
              )}
              <Link href="/download" onClick={() => setOpen(false)} className="btn-ghost mt-1">
                <Download size={16} /> Télécharger
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
