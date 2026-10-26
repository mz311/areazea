"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const F = require("../fbm-updater/server/engine.js");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fbm-js-"));
const read = (dir, rel) => {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch (e) {
    return "<absent>";
  }
};

/** Faux serveur de fichiers (blobs en mémoire, compteur, corruption, 403). */
function blobServer() {
  const store = new Map();
  const s = { hits: 0, corrupt: null, expireFirst: false, urlCalls: 0 };
  const server = http.createServer((req, res) => {
    const m = /^\/(blob|expired)\/([a-f0-9]{64})$/.exec(req.url);
    if (m && m[1] === "expired") {
      res.statusCode = 403;
      return res.end("expired");
    }
    const data = m && store.get(m[2]);
    if (!data) {
      res.statusCode = 404;
      return res.end();
    }
    s.hits++;
    const out = Buffer.from(data);
    if (s.corrupt === m[2]) out[0] ^= 0xff;
    res.end(out);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.unref(); // un test en échec ne doit pas bloquer le processus
      s.close = () => {
        server.close();
        if (server.closeAllConnections) server.closeAllConnections();
      };
      s.add = (content) => {
        store.set(sha(content), content);
        return { sha256: sha(content), size: Buffer.byteLength(content) };
      };
      s.api = {
        blobUrls: async (_v, hashes) => {
          s.urlCalls++;
          const kind = s.expireFirst && s.urlCalls === 1 ? "expired" : "blob";
          return Object.fromEntries(hashes.map((h) => [h, `http://127.0.0.1:${port}/${kind}/${h}`]));
        },
      };
      resolve(s);
    }),
  );
}

function manifest(srv, files, prot) {
  return {
    files: Object.entries(files)
      .map(([p, c]) => Object.assign({ path: p }, srv.add(c)))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    managedDirs: ["resources"],
    protected: prot || [],
  };
}

async function sync(dir, srv, version, m, mode) {
  const p = await F.plan(dir, m, { mode: mode || "update" });
  await F.prepare({ dir, api: srv.api, remote: { version, channel: "STABLE", manifest: m }, plan: p, kind: "UPDATE", retries: 1 });
  return F.applyPendingSync(dir);
}

const PROT = ["server.cfg", "**/config.lua"];

test("installation initiale : fichiers écrits, état au format du launcher", async () => {
  const srv = await blobServer();
  const dir = tmp();
  const m = manifest(srv, { "server.cfg": "cfg", "resources/core/main.lua": "print(1)", "resources/core/config.lua": "Config={}" }, PROT);
  const r = await sync(dir, srv, "1.0.0", m);
  assert.deepStrictEqual([r.written, r.deleted], [3, 0]);
  assert.strictEqual(read(dir, "resources/core/main.lua"), "print(1)");
  const st = JSON.parse(read(dir, ".fbm/state.json"));
  assert.deepStrictEqual(Object.keys(st).sort(), ["channel", "files", "installed_at", "version"]);
  assert.strictEqual(st.version, "1.0.0");
  assert.ok(!fs.existsSync(path.join(dir, ".fbm/pending")) && !fs.existsSync(path.join(dir, ".fbm/txn.json")));
  srv.close();
});

test("préparation : rien ne change dans la base avant le redémarrage ; fbm cancel annule", async () => {
  const srv = await blobServer();
  const dir = tmp();
  await sync(dir, srv, "1.0.0", manifest(srv, { "resources/a.lua": "A1" }));
  const m2 = manifest(srv, { "resources/a.lua": "A2" });
  const p = await F.plan(dir, m2, {});
  await F.prepare({ dir, api: srv.api, remote: { version: "1.1.0", channel: "STABLE", manifest: m2 }, plan: p, kind: "UPDATE" });
  assert.strictEqual(read(dir, "resources/a.lua"), "A1");
  assert.strictEqual(F.readPending(dir).version, "1.1.0");
  F.cancelPending(dir);
  assert.strictEqual(F.readPending(dir), null);
  assert.strictEqual(F.applyPendingSync(dir), null);
  assert.strictEqual(read(dir, "resources/a.lua"), "A1");
  srv.close();
});

test("mise à jour différentielle : seuls les changements, configs et fichiers perso intacts", async () => {
  const srv = await blobServer();
  const dir = tmp();
  const v1 = manifest(srv, { "server.cfg": "cfg1", "resources/a/a.lua": "A1", "resources/a/config.lua": "c1", "resources/old/old.lua": "OLD", "resources/s/s.lua": "S", "readme.txt": "r" }, PROT);
  await sync(dir, srv, "1.0.0", v1);
  fs.writeFileSync(path.join(dir, "server.cfg"), "MON-SERVEUR");
  fs.writeFileSync(path.join(dir, "resources/a/config.lua"), "MA-CONFIG");
  fs.mkdirSync(path.join(dir, "resources/perso"));
  fs.writeFileSync(path.join(dir, "resources/perso/x.lua"), "PERSO");
  const v2 = manifest(srv, { "server.cfg": "cfg2", "resources/a/a.lua": "A2", "resources/a/config.lua": "c2", "resources/new/n.lua": "N", "resources/s/s.lua": "S" }, PROT);
  const before = srv.hits;
  const r = await sync(dir, srv, "1.1.0", v2);
  assert.strictEqual(srv.hits - before, 2, "a.lua + n.lua uniquement");
  assert.deepStrictEqual([r.written, r.deleted, r.keptProtected], [2, 1, 2]);
  assert.strictEqual(read(dir, "resources/a/a.lua"), "A2");
  assert.strictEqual(read(dir, "resources/new/n.lua"), "N");
  assert.strictEqual(read(dir, "resources/old/old.lua"), "<absent>");
  assert.ok(!fs.existsSync(path.join(dir, "resources/old")) && fs.existsSync(path.join(dir, "resources")));
  assert.strictEqual(read(dir, "readme.txt"), "r", "fichier racine : jamais supprimé");
  assert.strictEqual(read(dir, "server.cfg"), "MON-SERVEUR");
  assert.strictEqual(read(dir, "resources/a/config.lua"), "MA-CONFIG");
  assert.strictEqual(read(dir, "resources/perso/x.lua"), "PERSO");
  srv.close();
});

test("téléchargement corrompu : échec, aucune préparation, base intacte", async () => {
  const srv = await blobServer();
  const dir = tmp();
  await sync(dir, srv, "1.0.0", manifest(srv, { "resources/a.lua": "A1" }));
  const m2 = manifest(srv, { "resources/a.lua": "A2" });
  srv.corrupt = m2.files[0].sha256;
  const p = await F.plan(dir, m2, {});
  await assert.rejects(
    F.prepare({ dir, api: srv.api, remote: { version: "1.1.0", channel: "STABLE", manifest: m2 }, plan: p, kind: "UPDATE", retries: 1 }),
    (e) => e.code === "integrity",
  );
  assert.strictEqual(F.readPending(dir), null);
  assert.ok(!fs.existsSync(path.join(dir, ".fbm/pending")));
  assert.strictEqual(read(dir, "resources/a.lua"), "A1");
  srv.close();
});

test("échec pendant l'application : tout est restauré et la préparation est conservée pour réessayer", async () => {
  const srv = await blobServer();
  const dir = tmp();
  await sync(dir, srv, "1.0.0", manifest(srv, { "resources/a.lua": "A1", "resources/old.lua": "OLD" }));
  fs.writeFileSync(path.join(dir, "resources/zz"), "je suis un fichier");
  const m2 = manifest(srv, { "resources/a.lua": "A2", "resources/zz/n.lua": "N" });
  const p = await F.plan(dir, m2, {});
  await F.prepare({ dir, api: srv.api, remote: { version: "1.1.0", channel: "STABLE", manifest: m2 }, plan: p, kind: "UPDATE" });
  assert.throws(() => F.applyPendingSync(dir), (e) => e.code === "io");
  assert.strictEqual(read(dir, "resources/a.lua"), "A1");
  assert.strictEqual(read(dir, "resources/old.lua"), "OLD");
  assert.strictEqual(F.loadState(dir).version, "1.0.0");
  assert.ok(!fs.existsSync(path.join(dir, ".fbm/txn.json")) && !fs.existsSync(path.join(dir, ".fbm/backup")));
  assert.strictEqual(F.readPending(dir).version, "1.1.0", "réessayée au prochain démarrage");
  // l'utilisateur corrige le problème : le redémarrage suivant applique la mise à jour
  fs.rmSync(path.join(dir, "resources/zz"));
  assert.strictEqual(F.applyPendingSync(dir).version, "1.1.0");
  assert.strictEqual(read(dir, "resources/zz/n.lua"), "N");
  srv.close();
});

test("fichiers préparés altérés : refus d'appliquer, préparation abandonnée", async () => {
  const srv = await blobServer();
  const dir = tmp();
  await sync(dir, srv, "1.0.0", manifest(srv, { "resources/a.lua": "A1" }));
  const m2 = manifest(srv, { "resources/a.lua": "A2" });
  const p = await F.plan(dir, m2, {});
  await F.prepare({ dir, api: srv.api, remote: { version: "1.1.0", channel: "STABLE", manifest: m2 }, plan: p, kind: "UPDATE" });
  fs.writeFileSync(path.join(dir, ".fbm/pending/blobs", m2.files[0].sha256), "A3");
  assert.throws(() => F.applyPendingSync(dir), (e) => e.code === "integrity");
  assert.strictEqual(read(dir, "resources/a.lua"), "A1");
  assert.strictEqual(F.readPending(dir), null);
  srv.close();
});

test("config protégée créée entre la préparation et le redémarrage : conservée", async () => {
  const srv = await blobServer();
  const dir = tmp();
  const m = manifest(srv, { "server.cfg": "défaut", "resources/a.lua": "A" }, PROT);
  const p = await F.plan(dir, m, {});
  await F.prepare({ dir, api: srv.api, remote: { version: "1.0.0", channel: "STABLE", manifest: m }, plan: p, kind: "INSTALL" });
  fs.writeFileSync(path.join(dir, "server.cfg"), "MA CONFIG");
  const r = F.applyPendingSync(dir);
  assert.strictEqual(read(dir, "server.cfg"), "MA CONFIG");
  assert.strictEqual(r.keptProtected, 1);
  assert.ok(!("server.cfg" in F.loadState(dir).files));
  srv.close();
});

test("réparation : détecte une corruption de même taille ; retour en arrière", async () => {
  const srv = await blobServer();
  const dir = tmp();
  const v1 = manifest(srv, { "resources/a.lua": "A1", "resources/b.lua": "B", "resources/gone.lua": "G" });
  await sync(dir, srv, "1.0.0", v1);
  fs.writeFileSync(path.join(dir, "resources/b.lua"), "X");
  assert.strictEqual((await F.plan(dir, v1, { mode: "update" })).writes.length, 0);
  assert.strictEqual((await F.plan(dir, v1, { mode: "repair" })).writes.length, 1);
  await sync(dir, srv, "1.0.0", v1, "repair");
  assert.strictEqual(read(dir, "resources/b.lua"), "B");
  const v2 = manifest(srv, { "resources/a.lua": "A2", "resources/b.lua": "B", "resources/added.lua": "ADD" });
  await sync(dir, srv, "1.1.0", v2);
  await sync(dir, srv, "1.0.0", v1);
  assert.deepStrictEqual([read(dir, "resources/a.lua"), read(dir, "resources/gone.lua"), read(dir, "resources/added.lua")], ["A1", "G", "<absent>"]);
  srv.close();
});

test("contenu identique téléchargé une seule fois ; lien expiré renouvelé", async () => {
  const srv = await blobServer();
  const dir = tmp();
  srv.expireFirst = true;
  const r = await sync(dir, srv, "1.0.0", manifest(srv, { "resources/a.lua": "SAME", "resources/b.lua": "SAME" }));
  assert.strictEqual(r.written, 2);
  assert.strictEqual(srv.hits, 1);
  assert.strictEqual(srv.urlCalls, 2, "un nouveau lien a été demandé après le 403");
  srv.close();
});

test("chemins malveillants refusés avant toute écriture", async () => {
  const srv = await blobServer();
  const dir = tmp();
  for (const evil of ["../evil.lua", "/abs.lua", "C:/win.lua", "a\\b.lua", "resources/../../x", ".fbm/state.json", "resources/nul.txt", "a//b"]) {
    const m = manifest(srv, { "resources/ok.lua": "ok", [evil]: "pwn" });
    await assert.rejects(F.plan(dir, m, {}), (e) => e.code === "unsafe_path", evil);
  }
  assert.ok(!fs.existsSync(path.join(dir, "resources")));
  srv.close();
});

test("reprise après crash : journal du launcher (format Rust) restauré", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "resources"));
  fs.mkdirSync(path.join(dir, ".fbm/backup/t1/resources"), { recursive: true });
  fs.writeFileSync(path.join(dir, "resources/a.lua"), "MOITIE");
  fs.writeFileSync(path.join(dir, "resources/new.lua"), "NEW");
  fs.writeFileSync(path.join(dir, ".fbm/backup/t1/resources/a.lua"), "ORIGINAL");
  fs.writeFileSync(path.join(dir, ".fbm/backup/t1/resources/deleted.lua"), "D");
  fs.writeFileSync(
    path.join(dir, ".fbm/txn.json"),
    JSON.stringify({
      id: "t1",
      committing: true,
      ops: [
        { path: "resources/a.lua", write: true, had_original: true },
        { path: "resources/new.lua", write: true, had_original: false },
        { path: "resources/deleted.lua", write: false, had_original: true },
      ],
    }),
  );
  assert.strictEqual(F.recoverSync(dir), true);
  assert.deepStrictEqual([read(dir, "resources/a.lua"), read(dir, "resources/new.lua"), read(dir, "resources/deleted.lua")], ["ORIGINAL", "<absent>", "D"]);
  assert.ok(!fs.existsSync(path.join(dir, ".fbm/txn.json")) && !fs.existsSync(path.join(dir, ".fbm/backup")));
  assert.strictEqual(F.recoverSync(dir), false);
});

test("parité avec le serveur et le launcher : empreinte du manifeste, motifs, chemins", () => {
  const m = {
    files: [
      { path: "resources/é/a.lua", sha256: "a".repeat(64), size: 12 },
      { path: "server.cfg", sha256: "b".repeat(64), size: 0 },
    ],
    managedDirs: ["resources"],
    protected: ["server.cfg", "**/config.lua"],
  };
  assert.strictEqual(F.manifestDigest(m), "024099ced154d9d07a286932abd62ca61cdc8d047fbe2d96a7492817f66f76d6");
  const cases = [
    ["server.cfg", "SERVER.CFG", true],
    ["**/config.lua", "resources/x/config.lua", true],
    ["**/config.lua", "config.lua", true],
    ["txData/**", "txData/a/b.json", true],
    ["**/*.local.*", "resources/x/a.local.json", true],
    ["**/config.lua", "resources/x/client.lua", false],
    ["server.cfg", "resources/server.cfg.bak", false],
    ["a+b(1).lua", "aab(1).lua", false],
    ["res?/x", "res1/y/x", false],
  ];
  for (const [g, p, want] of cases) assert.strictEqual(F.globToRegExp(g).test(p), want, `${g} vs ${p}`);
  for (const bad of ["../x", "/x", "C:/x", "a\\b", "a//b", "./a", "CON", "a/nul.txt", "d/f.", "d /f", "a/b:s", ".fbm/x", ""]) {
    assert.throws(() => F.validateRel(bad), undefined, bad);
  }
  assert.strictEqual(F.guessBaseDir("/srv/fivem/resources/[fbm]/fbm-updater"), "/srv/fivem");
});
