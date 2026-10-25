import { route } from "@/lib/api";
import { avatarUrl } from "@/lib/auth/discord";

export const runtime = "nodejs";

export const GET = route({ auth: "bearer", rate: { name: "l-me", limit: 60, windowMs: 60_000 } }, async ({ user }) => ({
  user: {
    name: user!.globalName ?? user!.username,
    avatar: avatarUrl(user!),
    role: user!.effective,
    inGuild: user!.inGuild,
  },
}));
