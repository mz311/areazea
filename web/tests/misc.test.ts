import { describe, expect, it } from "vitest";
import { signPayload, verifyPayload } from "@/lib/crypto";
import { canDownload, effectiveRole, hasRole } from "@/lib/rbac";
import { rateLimit, resetRateLimits } from "@/lib/rate-limit";

describe("jetons signés", () => {
  const secret = "s".repeat(40);
  it("valide un jeton correct", () => {
    const t = signPayload(secret, { k: "blobs/x" }, 60);
    expect(verifyPayload<{ k: string }>(secret, t)?.k).toBe("blobs/x");
  });
  it("refuse un jeton altéré, mauvais secret, expiré", () => {
    const t = signPayload(secret, { k: "a" }, 60);
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "b", exp: 9999999999 })).toString("base64url");
    expect(verifyPayload(secret, `${forged}.${sig}`)).toBeNull();
    expect(verifyPayload(secret, `${body}.x${sig}`)).toBeNull();
    expect(verifyPayload("o".repeat(40), t)).toBeNull();
    expect(verifyPayload(secret, signPayload(secret, { k: "a" }, -5))).toBeNull();
    expect(verifyPayload(secret, "garbage")).toBeNull();
  });
});

describe("rbac", () => {
  const u = (o: Partial<{ role: any; roleOverride: any; inGuild: boolean; banned: boolean }> = {}) => ({
    role: "MEMBER" as const,
    roleOverride: null,
    inGuild: true,
    banned: false,
    ...o,
  });
  it("hiérarchie des rôles", () => {
    expect(hasRole("ADMIN", "VIP")).toBe(true);
    expect(hasRole("MEMBER", "VIP")).toBe(false);
    expect(effectiveRole({ role: "MEMBER", roleOverride: "ADMIN" })).toBe("ADMIN");
  });
  it("accès au téléchargement", () => {
    expect(canDownload(u(), { minRole: "MEMBER" })).toBe(true);
    expect(canDownload(u(), { minRole: "VIP" })).toBe(false);
    expect(canDownload(u({ role: "VIP" }), { minRole: "VIP" })).toBe(true);
    expect(canDownload(u({ inGuild: false, role: "ADMIN" }), { minRole: "MEMBER" })).toBe(false);
    expect(canDownload(u({ banned: true, role: "ADMIN" }), { minRole: "MEMBER" })).toBe(false);
    expect(canDownload(u({ roleOverride: "DEVELOPER" }), { minRole: "DEVELOPER" })).toBe(true);
  });
});

describe("rate limit", () => {
  it("bloque au-delà de la limite puis libère", () => {
    resetRateLimits();
    expect(rateLimit("k", 2, 1000, 0).ok).toBe(true);
    expect(rateLimit("k", 2, 1000, 10).ok).toBe(true);
    const r = rateLimit("k", 2, 1000, 20);
    expect(r.ok).toBe(false);
    expect(rateLimit("k", 2, 1000, 1500).ok).toBe(true);
    expect(rateLimit("other", 2, 1000, 20).ok).toBe(true);
  });
});
