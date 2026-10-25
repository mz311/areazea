import { route } from "@/lib/api";
import { audit } from "@/lib/audit";
import { compareVersions, makeCurrent } from "@/lib/versions";

export const runtime = "nodejs";

/** Définit cette version publiée comme version courante du canal : les launchers s'y synchronisent (retour en arrière inclus). */
export const POST = route<{ id: string }>({ auth: "session", minRole: "ADMIN" }, async ({ params, user, ip }) => {
  const { version, previous } = await makeCurrent(params.id);
  const isRollback = !!previous && compareVersions(version.version, previous.version) > 0; // rcompare > 0 : version plus ancienne
  await audit(user!.id, isRollback ? "version.rollback" : "version.set_current", version.version, { from: previous?.version ?? null }, ip);
  return { ok: true, current: version.version, previous: previous?.version ?? null, rollback: isRollback };
});
