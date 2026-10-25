import Link from "next/link";

export function Footer({ siteName, discordUrl }: { siteName: string; discordUrl: string }) {
  return (
    <footer className="mt-24 border-t border-white/5 py-10 text-sm text-zinc-500">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4">
        <p>© {new Date().getFullYear()} {siteName}. Non affilié à Rockstar Games, Take-Two ni Cfx.re.</p>
        <div className="flex gap-5">
          <Link href="/updates" className="hover:text-neon-300">Mises à jour</Link>
          <Link href="/download" className="hover:text-neon-300">Télécharger</Link>
          {discordUrl && (
            <a href={discordUrl} className="hover:text-neon-300" target="_blank" rel="noopener noreferrer">
              Discord
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
