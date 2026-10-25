import { redirect } from "next/navigation";
import { LauncherConsent } from "@/components/LauncherConsent";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function LauncherAuth({ searchParams }: { searchParams: Promise<{ port?: string; state?: string }> }) {
  const { port, state } = await searchParams;
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535 || !state || !/^[A-Za-z0-9_-]{8,128}$/.test(state)) {
    return <p className="card mx-auto max-w-md p-8 text-center text-red-300">Requête du launcher invalide.</p>;
  }
  const user = await getSessionUser();
  if (!user) redirect(`/api/auth/discord/login?returnTo=${encodeURIComponent(`/launcher/auth?port=${p}&state=${state}`)}`);
  return <LauncherConsent port={p} state={state} user={user.globalName ?? user.username} />;
}
