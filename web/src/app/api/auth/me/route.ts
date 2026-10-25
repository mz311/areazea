import { route } from "@/lib/api";
import { avatarUrl } from "@/lib/auth/discord";
import { getSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";

export const GET = route({}, async () => {
  const u = await getSessionUser();
  if (!u) return { user: null };
  return {
    user: {
      id: u.id,
      discordId: u.discordId,
      name: u.globalName ?? u.username,
      avatar: avatarUrl(u),
      role: u.effective,
      inGuild: u.inGuild,
    },
  };
});
