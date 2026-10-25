/**
 * Test bout-en-bout : lance réellement Next.js (mode dev) contre une base PostgreSQL de test
 * et un stockage local temporaire, puis exerce toute la chaîne via HTTP.
 * Prérequis : PostgreSQL avec la base `fbm_test` (voir README).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { S3Storage } from "@/lib/storage/s3";
import { makeZip, makeZipWithRawName } from "../helpers";

/** E2E_S3=1 : utilise un serveur S3 compatible (ex. `moto_server -p 5555`) au lieu du stockage local. */
const S3 = process.env.E2E_S3 === "1";
const S3_ENV = {
  STORAGE_DRIVER: "s3",
  S3_ENDPOINT: process.env.E2E_S3_ENDPOINT ?? "http://127.0.0.1:5555",
  S3_BUCKET: process.env.E2E_S3_BUCKET ?? "fbm-test",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  S3_REGION: "us-east-1",
  S3_FORCE_PATH_STYLE: "true",
};
const PORT = 3111;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.TEST_DATABASE_URL ?? "postgresql://fbm:fbm@localhost:5432/fbm_test";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

let server: ChildProcess;
let storageDir: string;
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });

const tokens = { admin: "t-admin", member: "t-member", vip: "t-vip", outsider: "t-outsider", dev: "t-dev" } as const;
const cookie = (k: keyof typeof tokens) => `fbm_session=${tokens[k]}`;

async function seedUser(key: keyof typeof tokens, discordId: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { discordId, username: key, inGuild: true, ...extra } });
  await prisma.session.create({ data: { tokenHash: sha(tokens[key]), userId: u.id, expiresAt: new Date(Date.now() + 3600_000) } });
  return u;
}

async function api(method: string, p: string, o: { as?: keyof typeof tokens; body?: unknown; raw?: Buffer; bearer?: string; origin?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.as) headers.cookie = cookie(o.as);
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.origin !== false && o.as && method !== "GET") headers.origin = BASE;
  let body: BodyInit | undefined;
  if (o.raw) {
    body = new Uint8Array(o.raw);
    headers["content-type"] = headers["content-type"] ?? "application/octet-stream";
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(BASE + p, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function upload(version: string, files: Record<string, string>, qs = "") {
  const zip = await makeZip(files);
  return api("POST", `/api/admin/versions/upload?version=${version}${qs}`, { as: "admin", raw: await readFile(zip), headers: { "content-type": "application/zip" } });
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), "fbm-e2e-store-"));
  if (S3) {
    // isolation : un bucket non vide fausserait les compteurs de blobs (dédoublonnage) et le test de GC
    const st = new S3Storage({ endpoint: S3_ENV.S3_ENDPOINT, region: S3_ENV.S3_REGION, bucket: S3_ENV.S3_BUCKET, accessKeyId: "test", secretAccessKey: "test", forcePathStyle: true });
    for (const key of await st.list("")) await st.delete(key);
  }
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: DB }, stdio: "pipe" });
  await prisma.$executeRawUnsafe(`TRUNCATE "AuditLog","Download","Change","Version","Session","LauncherToken","Announcement","Setting","MediaAsset","User" CASCADE`);
  await seedUser("admin", "999999999999999999");
  await seedUser("member", "100000000000000001");
  await seedUser("vip", "100000000000000002", { role: "VIP" });
  await seedUser("dev", "100000000000000004", { role: "DEVELOPER" });
  await seedUser("outsider", "100000000000000003", { inGuild: false });

  server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      APP_URL: BASE,
      DATABASE_URL: DB,
      APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-1234",
      DISCORD_CLIENT_ID: "1",
      DISCORD_CLIENT_SECRET: "x",
      DISCORD_GUILD_ID: "2",
      ADMIN_DISCORD_IDS: "999999999999999999",
      ...(S3 ? S3_ENV : { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir }),
      MAX_UPLOAD_MB: "20",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_DIST_DIR: ".next-e2e",
    },
    stdio: "pipe",
    detached: true, // groupe de processus dédié : on tue next ET ses enfants à la fin
  });
  let log = "";
  let exited = false;
  server.on("exit", () => (exited = true));
  server.stdout?.on("data", (d) => (log += d));
  server.stderr?.on("data", (d) => (log += d));
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/public/latest`);
      if (r.status < 500) break;
    } catch {}
    if (exited) throw new Error("le serveur Next s'est arrêté :\n" + log.slice(-2000));
    if (Date.now() - t0 > 150_000) throw new Error("serveur Next non démarré :\n" + log.slice(-2000));
    await new Promise((r) => setTimeout(r, 1000));
  }
});

afterAll(async () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
  await prisma.$disconnect();
  await rm(storageDir, { recursive: true, force: true });
});

describe("contrôle d'accès", () => {
  it("401 sans session, 403 pour un simple membre", async () => {
    expect((await api("GET", "/api/admin/versions")).status).toBe(401);
    expect((await api("GET", "/api/admin/versions", { as: "member" })).status).toBe(403);
    expect((await api("GET", "/api/admin/versions", { as: "vip" })).status).toBe(403);
    expect((await api("GET", "/api/admin/versions", { as: "dev" })).status).toBe(403);
    expect((await api("GET", "/api/admin/versions", { as: "admin" })).status).toBe(200);
  });

  it("CSRF : requête modifiante sans Origin / avec mauvaise Origin refusée", async () => {
    const noOrigin = await api("PUT", "/api/admin/settings", { as: "admin", body: { siteName: "X" }, origin: false });
    expect(noOrigin.status).toBe(403);
    const evil = await api("PUT", "/api/admin/settings", { as: "admin", body: { siteName: "X" }, origin: false, headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect((await api("PUT", "/api/admin/settings", { as: "admin", body: { siteName: "Ma Base" } })).status).toBe(200);
  });

  it("réglages : refuse les URL javascript:", async () => {
    const r = await api("PUT", "/api/admin/settings", { as: "admin", body: { logoUrl: "javascript:alert(1)" } });
    expect(r.status).toBe(400);
  });

  it("/api/auth/me", async () => {
    expect((await api("GET", "/api/auth/me")).json.user).toBeNull();
    const me = await api("GET", "/api/auth/me", { as: "vip" });
    expect(me.json.user.role).toBe("VIP");
  });
});

describe("upload, publication, téléchargement", () => {
  let v1: any;
  it("refuse version invalide / archive non-ZIP / zip-slip / extension bloquée", async () => {
    expect((await upload("pas-une-version", { "a.lua": "1" })).status).toBe(400);
    const notZip = await api("POST", "/api/admin/versions/upload?version=0.0.1", { as: "admin", raw: Buffer.from("ceci n'est pas un zip"), headers: { "content-type": "application/zip" } });
    expect(notZip.status).toBe(422);
    const slip = await makeZipWithRawName("x".repeat(14), "../../evil.lua");
    const r = await api("POST", "/api/admin/versions/upload?version=0.0.2", { as: "admin", raw: await readFile(slip), headers: { "content-type": "application/zip" } });
    expect(r.status).toBe(422);
    expect((await upload("0.0.3", { "tool/run.exe": "MZ" })).json.error).toMatch(/Extension interdite/);
    expect((await api("GET", "/api/admin/versions", { as: "admin" })).json.versions).toHaveLength(0);
  });

  it("refuse une archive qui dépasse la limite d'upload", async () => {
    const big = await makeZip({ "big.bin": Buffer.alloc(1, 1) });
    const r = await api("POST", "/api/admin/versions/upload?version=0.0.4", { as: "admin", raw: Buffer.alloc(21 * 1024 * 1024, 7), headers: { "content-type": "application/zip" } });
    expect([413, 422]).toContain(r.status);
    void big;
  });

  it("upload v1.0.0 → brouillon + manifeste", async () => {
    const r = await upload("1.0.0", {
      "base/server.cfg": "endpoint_add_tcp 30120",
      "base/resources/core/fxmanifest.lua": "fx_version 'cerulean'",
      "base/resources/core/config.lua": "Config = {}",
      "base/resources/old/old.lua": "-- à supprimer en 1.1.0",
    });
    expect(r.status).toBe(200);
    v1 = r.json;
    expect(v1.fileCount).toBe(4);
    expect(v1.strippedRoot).toBe("base/");
    expect((await upload("1.0.0", { "a": "1" })).status).toBe(409);
  });

  it("un brouillon n'est ni téléchargeable ni public", async () => {
    expect((await api("POST", "/api/download/1.0.0/link", { as: "member" })).status).toBe(404);
    expect((await api("GET", "/api/public/latest")).json.latest).toBeNull();
  });

  it("changelog + publication", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const bad = await api("POST", "/api/admin/media", { as: "admin", raw: Buffer.from("<svg onload=alert(1)>"), headers: { "content-type": "image/png" } });
    expect(bad.status).toBe(415);
    const media = await api("POST", "/api/admin/media", { as: "admin", raw: png, headers: { "content-type": "image/png" } });
    expect(media.status).toBe(200);
    const img = await fetch(BASE + media.json.url);
    expect(img.headers.get("content-type")).toBe("image/png");

    const put = await api("PUT", `/api/admin/versions/${v1.id}`, {
      as: "admin",
      body: {
        title: "Lancement",
        summary: "Première version",
        changes: [
          { type: "NEW", text: "Système de garage", imageId: media.json.id },
          { type: "FIX", text: "Correction du spawn" },
          { type: "IMPROVEMENT", text: "Chargement 2x plus rapide" },
        ],
      },
    });
    expect(put.status).toBe(200);
    const pub = await api("POST", `/api/admin/versions/${v1.id}/publish`, { as: "admin", body: { notifyDiscord: false } });
    expect(pub.status).toBe(200);
    expect((await api("POST", `/api/admin/versions/${v1.id}/publish`, { as: "admin", body: {} })).status).toBe(409);
    const latest = await api("GET", "/api/public/latest");
    expect(latest.json.latest.version).toBe("1.0.0");
    const updates = await api("GET", "/api/public/updates");
    expect(updates.json.versions[0].changes.map((c: any) => c.type)).toEqual(["NEW", "FIX", "IMPROVEMENT"]);
  });

  it("téléchargement ZIP : lien temporaire signé + SHA-256 vérifié", async () => {
    const r = await api("POST", "/api/download/1.0.0/link", { as: "member" });
    expect(r.status).toBe(200);
    const file = await fetch(r.json.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/attachment/);
    const body = Buffer.from(await file.arrayBuffer());
    expect(sha(body)).toBe(r.json.sha256);
    expect(body.length).toBe(r.json.size);
    if (!S3) {
      // lien HMAC altéré (en mode S3 la signature est vérifiée par le bucket, pas par l'application)
      const tampered = r.json.url.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
      expect((await fetch(tampered)).status).toBe(403);
      expect((await fetch(BASE + "/api/files/garbage")).status).toBe(403);
    } else {
      expect(r.json.url).toMatch(/X-Amz-Signature=/); // lien présigné S3
      expect(r.json.url).toMatch(/X-Amz-Expires=300/);
    }
    expect((await api("GET", "/api/public/latest")).json.downloads).toBe(1);
  });

  it("refuse les non-membres du serveur et les anonymes", async () => {
    const out = await api("POST", "/api/download/1.0.0/link", { as: "outsider" });
    expect(out.status).toBe(403);
    expect(out.json.code).toBe("not_in_guild");
    expect((await api("POST", "/api/download/1.0.0/link")).status).toBe(401);
  });

  it("rôles : version VIP réservée", async () => {
    const up = await upload("1.0.1", { "server.cfg": "vip" }, "&minRole=VIP");
    expect(up.status).toBe(200);
    await api("POST", `/api/admin/versions/${up.json.id}/publish`, { as: "admin", body: { makeCurrent: false, notifyDiscord: false } });
    expect((await api("POST", "/api/download/1.0.1/link", { as: "member" })).json.code).toBe("role_required");
    expect((await api("POST", "/api/download/1.0.1/link", { as: "vip" })).status).toBe(200);
    expect((await api("POST", "/api/download/1.0.1/link", { as: "admin" })).status).toBe(200);
    // la version VIP n'apparaît pas dans la liste publique
    const pub = await api("GET", "/api/public/updates");
    expect(pub.json.versions.map((v: any) => v.version)).not.toContain("1.0.1");
  });
});

describe("API launcher + mises à jour différentielles + rollback", () => {
  let token: string;
  let tokenId: string;

  it("consentement : crée un jeton launcher (loopback validé)", async () => {
    expect((await api("POST", "/api/account/tokens", { as: "member", body: { port: 80 } })).status).toBe(400);
    const r = await api("POST", "/api/account/tokens", { as: "member", body: { name: "PC test", port: 53123, state: "abcdefgh12345678" } });
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^fvl_/);
    expect(r.json.redirect).toMatch(/^http:\/\/127\.0\.0\.1:53123\/callback\?token=fvl_/);
    token = r.json.token;
    tokenId = r.json.id;
    const list = await api("GET", "/api/account/tokens", { as: "member" });
    expect(list.json.tokens[0].name).toBe("PC test");
    expect(JSON.stringify(list.json)).not.toContain(token); // le jeton n'est jamais ré-affiché
  });

  it("jeton invalide / cookie de session non accepté sur les routes bearer", async () => {
    expect((await api("GET", "/api/launcher/latest")).status).toBe(401);
    expect((await api("GET", "/api/launcher/latest", { bearer: "fvl_" + "x".repeat(40) })).status).toBe(401);
    expect((await api("GET", "/api/launcher/latest", { as: "member" })).status).toBe(401);
  });

  it("latest + manifeste + liens des blobs vérifiés par SHA-256", async () => {
    const r = await api("GET", "/api/launcher/latest", { bearer: token });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe("1.0.0");
    expect(r.json.manifest.files).toHaveLength(4);
    expect(r.json.manifest.protected).toContain("server.cfg");
    expect(r.json.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    const hashes = r.json.manifest.files.map((f: any) => f.sha256);
    const blobs = await api("POST", "/api/launcher/blobs", { bearer: token, body: { version: "1.0.0", hashes } });
    expect(blobs.status).toBe(200);
    for (const f of r.json.manifest.files) {
      const res = await fetch(blobs.json.urls[f.sha256]);
      const b = Buffer.from(await res.arrayBuffer());
      expect(sha(b)).toBe(f.sha256);
      expect(b.length).toBe(f.size);
    }
    // un hash d'un autre fichier du stockage (hors manifeste) est refusé
    const foreign = sha("pas-dans-le-manifeste");
    expect((await api("POST", "/api/launcher/blobs", { bearer: token, body: { version: "1.0.0", hashes: [foreign] } })).json.code).toBe("not_in_manifest");
    expect((await api("POST", "/api/launcher/blobs", { bearer: token, body: { version: "1.0.0", hashes: ["../etc/passwd"] } })).status).toBe(400);
    // le membre n'a pas le droit de demander la version VIP
    expect((await api("GET", "/api/launcher/latest?version=1.0.1", { bearer: token })).json.code).toBe("role_required");
    expect((await api("POST", "/api/launcher/report", { bearer: token, body: { version: "1.0.0", kind: "INSTALL" } })).status).toBe(200);
  });

  let v11: any;
  it("v1.1.0 : diff = 1 modifié, 1 ajouté, 1 supprimé ; seuls les nouveaux blobs sont stockés", async () => {
    const up = await upload("1.1.0", {
      "server.cfg": "endpoint_add_tcp 30120", // inchangé
      "resources/core/fxmanifest.lua": "fx_version 'cerulean'\n-- v2", // modifié
      "resources/core/config.lua": "Config = {}", // inchangé
      "resources/new/new.lua": "print('new')", // ajouté ; old.lua supprimé
    });
    expect(up.status).toBe(200);
    v11 = up.json;
    expect(v11.diff).toMatchObject({ against: "1.0.0", added: 1, modified: 1, removed: 1, unchanged: 2 });
    expect(v11.newBlobs).toBe(2);
    expect(v11.diff.downloadSize).toBeLessThan(v11.totalSize);
    await api("POST", `/api/admin/versions/${v11.id}/publish`, { as: "admin", body: { notifyDiscord: false } });
    expect((await api("GET", "/api/launcher/latest", { bearer: token })).json.version).toBe("1.1.0");
  });

  it("rollback vers 1.0.0 : les launchers se resynchronisent sur la version précédente", async () => {
    const versions = (await api("GET", "/api/admin/versions", { as: "admin" })).json.versions;
    const v10 = versions.find((v: any) => v.version === "1.0.0");
    const rb = await api("POST", `/api/admin/versions/${v10.id}/rollback`, { as: "admin" });
    expect(rb.json).toMatchObject({ current: "1.0.0", previous: "1.1.0", rollback: true });
    expect((await api("GET", "/api/launcher/latest", { bearer: token })).json.version).toBe("1.0.0");
    expect((await api("GET", "/api/public/latest")).json.latest.version).toBe("1.0.0");
    // impossible de supprimer la version courante
    expect((await api("DELETE", `/api/admin/versions/${v10.id}`, { as: "admin" })).json.code).toBe("is_current");
    // on repasse en avant
    await api("POST", `/api/admin/versions/${v11.id}/rollback`, { as: "admin" });
    expect((await api("GET", "/api/launcher/latest", { bearer: token })).json.version).toBe("1.1.0");
  });

  it("GC des blobs : rien d'orphelin tant que les versions existent", async () => {
    const r = await api("POST", "/api/admin/storage/gc", { as: "admin", body: { dryRun: true } });
    expect(r.json.orphans).toBe(0);
  });

  it("canal bêta réservé aux développeurs", async () => {
    const up = await upload("2.0.0-beta.1", { "server.cfg": "beta" }, "&channel=BETA");
    expect(up.status).toBe(200);
    await api("POST", `/api/admin/versions/${up.json.id}/publish`, { as: "admin", body: { notifyDiscord: false } });
    const dev = await api("POST", "/api/account/tokens", { as: "dev", body: { name: "dev" } });
    expect((await api("GET", "/api/launcher/latest?channel=BETA", { bearer: dev.json.token })).json.version).toBe("2.0.0-beta.1");
    expect((await api("GET", "/api/launcher/latest?channel=BETA", { bearer: token })).status).toBe(403);
    // la bêta n'a pas déplacé la version stable
    expect((await api("GET", "/api/launcher/latest", { bearer: token })).json.version).toBe("1.1.0");
  });

  it("maintenance : bloque membres et launcher, pas les admins", async () => {
    await api("PUT", "/api/admin/settings", { as: "admin", body: { maintenance: { enabled: true, message: "Migration serveur" } } });
    const r = await api("GET", "/api/launcher/latest", { bearer: token });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("Migration serveur");
    expect((await api("POST", "/api/download/1.1.0/link", { as: "member" })).status).toBe(503);
    expect((await api("POST", "/api/download/1.1.0/link", { as: "admin" })).status).toBe(200);
    await api("PUT", "/api/admin/settings", { as: "admin", body: { maintenance: { enabled: false, message: "" } } });
    expect((await api("GET", "/api/launcher/latest", { bearer: token })).status).toBe(200);
  });

  it("révocation du jeton et bannissement", async () => {
    expect((await api("DELETE", `/api/account/tokens/${tokenId}`, { as: "member" })).status).toBe(200);
    expect((await api("GET", "/api/launcher/latest", { bearer: token })).status).toBe(401);

    const users = (await api("GET", "/api/admin/users?q=outsider", { as: "admin" })).json.users;
    expect(users).toHaveLength(1);
    const member = (await api("GET", "/api/admin/users?q=member", { as: "admin" })).json.users[0];
    const promoted = await api("PATCH", `/api/admin/users/${member.id}`, { as: "admin", body: { roleOverride: "VIP" } });
    expect(promoted.status).toBe(200);
    expect((await api("POST", "/api/download/1.0.1/link", { as: "member" })).status).toBe(200); // accès VIP via surcharge
    await api("PATCH", `/api/admin/users/${member.id}`, { as: "admin", body: { banned: true } });
    expect((await api("GET", "/api/auth/me", { as: "member" })).json.user).toBeNull();
    const me = (await api("GET", "/api/admin/users?q=admin", { as: "admin" })).json.users[0];
    expect((await api("PATCH", `/api/admin/users/${me.id}`, { as: "admin", body: { banned: true } })).json.code).toBe("self_lockout");
  });
});

describe("annonces, stats, audit, limitation de débit", () => {
  it("annonces CRUD", async () => {
    const c = await api("POST", "/api/admin/announcements", { as: "admin", body: { kind: "NEWS", title: "Bienvenue", body: "Hello", pinned: true } });
    expect(c.status).toBe(200);
    const id = c.json.announcement.id;
    expect((await api("PUT", `/api/admin/announcements/${id}`, { as: "admin", body: { title: "Bienvenue !" } })).status).toBe(200);
    expect((await api("GET", "/api/admin/announcements", { as: "admin" })).json.announcements[0].title).toBe("Bienvenue !");
    expect((await api("DELETE", `/api/admin/announcements/${id}`, { as: "admin" })).status).toBe(200);
  });

  it("statistiques", async () => {
    const s = (await api("GET", "/api/admin/stats", { as: "admin" })).json;
    expect(s.totalDownloads).toBeGreaterThanOrEqual(2);
    expect(s.downloadsPerDay).toHaveLength(30);
    expect(s.perVersion.find((v: any) => v.version === "1.0.0").install).toBe(1);
  });

  it("journal d'audit", async () => {
    const a = (await api("GET", "/api/admin/audit", { as: "admin" })).json;
    const actions = a.logs.map((l: any) => l.action);
    for (const x of ["version.upload", "version.publish", "version.rollback", "user.update", "settings.update", "download.zip"]) expect(actions).toContain(x);
  });

  it("statut des services", async () => {
    const s = (await api("GET", "/api/public/status")).json;
    expect(s.services.find((x: any) => x.id === "db").state).toBe("operational");
    expect(s.services.find((x: any) => x.id === "storage").state).toBe("operational");
  });

  it("rate limit : 429 avec Retry-After", async () => {
    let last = 0;
    let retry: string | null = null;
    for (let i = 0; i < 70; i++) {
      const r = await api("GET", "/api/public/status", { headers: { "x-real-ip": "203.0.113.9" } });
      last = r.status;
      if (r.status === 429) {
        retry = r.headers.get("retry-after");
        break;
      }
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });
});
