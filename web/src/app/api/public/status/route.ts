import { route } from "@/lib/api";
import { getSettings } from "@/lib/settings";
import { getServiceStatus } from "@/lib/status";

export const runtime = "nodejs";

export const GET = route({ rate: { name: "pub-status", limit: 60, windowMs: 60_000 } }, async () => {
  const [services, s] = await Promise.all([getServiceStatus(), getSettings()]);
  return { services, maintenance: s.maintenance };
});
