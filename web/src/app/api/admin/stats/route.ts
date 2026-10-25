import { route } from "@/lib/api";
import { getAdminStats } from "@/lib/stats";

export const runtime = "nodejs";

export const GET = route({ auth: "session", minRole: "ADMIN" }, async () => getAdminStats());
