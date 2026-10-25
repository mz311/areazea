import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { destroySession } from "@/lib/auth/session";

export const runtime = "nodejs";

export const POST = route({ auth: "session" }, async () => {
  const res = NextResponse.json({ ok: true });
  await destroySession(res);
  return res;
});
