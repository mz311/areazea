import type { Version } from "@prisma/client";
import { HttpError } from "./api";
import type { AuthUser } from "./auth/session";
import { hasRole } from "./rbac";

export function assertCanDownload(user: AuthUser, version: Pick<Version, "minRole">) {
  if (user.banned) throw new HttpError(403, "Compte banni", "banned");
  if (!user.inGuild) throw new HttpError(403, "Vous devez rejoindre le serveur Discord (avec le rôle requis) pour télécharger", "not_in_guild");
  // `effective` inclut la surcharge manuelle et les admins d'amorçage (ADMIN_DISCORD_IDS).
  if (!hasRole(user.effective, version.minRole)) throw new HttpError(403, "Votre rôle ne permet pas d'accéder à cette version", "role_required");
}
