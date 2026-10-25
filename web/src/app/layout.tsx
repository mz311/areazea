import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Background } from "@/components/Background";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";
import { UpdateNotifier } from "@/components/UpdateNotifier";
import { avatarUrl } from "@/lib/auth/discord";
import { getSessionUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const s = await getSettings().catch(() => null);
  return {
    title: { default: s?.siteName ?? "FiveM Base", template: `%s · ${s?.siteName ?? "FiveM Base"}` },
    description: s?.tagline,
  };
}

export const viewport: Viewport = { themeColor: "#050509", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [settings, user] = await Promise.all([getSettings(), getSessionUser().catch(() => null)]);
  return (
    <html lang="fr">
      <body>
        <Background />
        <Navbar
          siteName={settings.siteName}
          logoUrl={settings.logoUrl}
          user={user ? { name: user.globalName ?? user.username, avatar: avatarUrl(user, 64), role: user.effective } : null}
        />
        {settings.maintenance.enabled && (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-200">
            🔧 Maintenance en cours{settings.maintenance.message ? ` — ${settings.maintenance.message}` : ""}
          </div>
        )}
        <main className="mx-auto max-w-6xl px-4 pt-10">{children}</main>
        <Footer siteName={settings.siteName} discordUrl={settings.discordInviteUrl} />
        <UpdateNotifier />
      </body>
    </html>
  );
}
