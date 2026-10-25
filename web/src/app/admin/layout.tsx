import { BarChart3, FileClock, Megaphone, Package, Settings, Users } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/admin", label: "Tableau de bord", icon: BarChart3 },
  { href: "/admin/versions", label: "Versions", icon: Package },
  { href: "/admin/announcements", label: "Annonces", icon: Megaphone },
  { href: "/admin/users", label: "Utilisateurs", icon: Users },
  { href: "/admin/audit", label: "Journal", icon: FileClock },
  { href: "/admin/settings", label: "Paramètres", icon: Settings },
];

/** Garde côté serveur : seuls les administrateurs voient le panel (les autres reçoivent un 404). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/api/auth/discord/login?returnTo=/admin");
  if (user.effective !== "ADMIN") notFound();
  return (
    <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <nav className="card flex gap-1 overflow-x-auto p-2 lg:flex-col">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-neon-500/10 hover:text-white">
              <n.icon size={16} className="text-neon-300" /> {n.label}
            </Link>
          ))}
        </nav>
      </aside>
      <section className="min-w-0">{children}</section>
    </div>
  );
}
