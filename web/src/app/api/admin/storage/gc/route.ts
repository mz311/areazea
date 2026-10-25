import { z } from "zod";
import { route, readJson } from "@/lib/api";
import { audit } from "@/lib/audit";
import { gcBlobs } from "@/lib/versions";

export const runtime = "nodejs";

export const POST = route({ auth: "session", minRole: "ADMIN", rate: { name: "gc", limit: 10, windowMs: 3600_000 } }, async ({ req, user, ip }) => {
  const { dryRun } = await readJson(req, z.object({ dryRun: z.boolean().default(true) }));
  const r = await gcBlobs(dryRun);
  if (!dryRun) await audit(user!.id, "storage.gc", null, r, ip);
  return r;
});
