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

import { computeAccess } from "@/lib/auth/discord";
import { sniffImage } from "@/lib/image";
import { safeReturnTo } from "@/lib/redirect";

describe("rôles Discord → rôles applicatifs", () => {
  const cfg = { member: [], vip: ["v1", "v2"], developer: ["d1"], admin: ["a1"], adminUserIds: ["boss"] };
  it("hiérarchie et plus haut rôle gagnant", () => {
    expect(computeAccess(cfg, "u", [])).toEqual({ inGuild: true, role: "MEMBER" });
    expect(computeAccess(cfg, "u", ["v2"])).toEqual({ inGuild: true, role: "VIP" });
    expect(computeAccess(cfg, "u", ["v1", "d1"]).role).toBe("DEVELOPER");
    expect(computeAccess(cfg, "u", ["v1", "d1", "a1"]).role).toBe("ADMIN");
  });
  it("hors serveur = pas d'accès ; admin d'amorçage reste admin", () => {
    expect(computeAccess(cfg, "u", null)).toEqual({ inGuild: false, role: "MEMBER" });
    expect(computeAccess(cfg, "boss", [])).toEqual({ inGuild: true, role: "ADMIN" });
  });
  it("rôle « membre vérifié » exigé quand il est configuré", () => {
    const strict = { ...cfg, member: ["m1"] };
    expect(computeAccess(strict, "u", []).inGuild).toBe(false);
    expect(computeAccess(strict, "u", ["m1"]).inGuild).toBe(true);
    expect(computeAccess(strict, "u", ["v1"]).inGuild).toBe(true); // un VIP est forcément vérifié
  });
});

describe("garde-fous divers", () => {
  it("safeReturnTo bloque les redirections ouvertes", () => {
    expect(safeReturnTo("/download")).toBe("/download");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "", null, undefined, "/a\u0000b"]) {
      expect(safeReturnTo(bad as string)).toBe("/download");
    }
  });
  it("sniffImage identifie par signature et refuse SVG/HTML", () => {
    expect(sniffImage(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"))).toBe("image/png");
    expect(sniffImage(Buffer.from("ffd8ffe000104a464946", "hex"))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
  });
});
