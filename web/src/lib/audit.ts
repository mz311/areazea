import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

export async function audit(
  actorId: string | null,
  action: string,
  target?: string | null,
  meta?: Prisma.InputJsonValue,
  ip?: string | null,
) {
  try {
    await prisma.auditLog.create({ data: { actorId, action, target: target ?? null, meta, ip: ip ?? null } });
  } catch (e) {
    console.error("audit:", (e as Error).message);
  }
}
