import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Badge, PageHeader } from "@/components/ui";
import { TokenManager } from "@/components/TokenManager";
import { avatarUrl } from "@/lib/auth/discord";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { ROLE_LABEL } from "@/lib/rbac";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Mon compte" };

export default async function AccountPage() {
  const user = await getSessionUser();
  if (!user) redirect("/api/auth/discord/login?returnTo=/account");
  const tokens = await prisma.launcherToken.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true },
  });
  return (
    <div className="space-y-8">
      <PageHeader title="Mon compte" />
      <div className="card flex flex-wrap items-center gap-5 p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatarUrl(user, 128)} alt="" width={72} height={72} className="h-[72px] w-[72px] rounded-2xl shadow-neon" />
        <div>
          <h2 className="text-2xl font-extrabold text-white">{user.globalName ?? user.username}</h2>
          <p className="text-sm text-zinc-500">@{user.username}</p>
          <div className="mt-2 flex gap-2">
            <Badge kind={user.effective}>{ROLE_LABEL[user.effective]}</Badge>
            {user.inGuild ? <Badge kind="NEW">Membre du serveur</Badge> : <Badge kind="FIX">Hors du serveur</Badge>}
          </div>
        </div>
      </div>
      <section className="card p-6">
        <h2 className="mb-1 text-lg font-extrabold text-white">Launchers connectés</h2>
        <p className="mb-4 text-sm text-zinc-500">Chaque launcher possède son propre jeton. Révoquez-le si vous perdez l&apos;accès à votre PC.</p>
        <TokenManager initial={JSON.parse(JSON.stringify(tokens))} />
      </section>
    </div>
  );
}
