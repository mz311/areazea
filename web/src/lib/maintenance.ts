import { HttpError } from "./api";
import { getSettings } from "./settings";
import type { AuthUser } from "./auth/session";

/** En maintenance, seuls les administrateurs peuvent encore télécharger. */
export async function assertNotMaintenance(user: AuthUser) {
  const s = await getSettings();
  if (s.maintenance.enabled && user.effective !== "ADMIN") {
    throw new HttpError(503, s.maintenance.message || "Maintenance en cours", "maintenance");
  }
}
