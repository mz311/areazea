"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { load } = require("./harness");
const F = require("../fbm-updater/server/engine.js");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Faux site : /api/launcher/latest, /blobs, /report et les blobs ; version courante modifiable. */
function fakeSite() {
  const blobs = new Map();
  const sqlContents = new Map();
  const site = { versions: {}, current: null, reports: [], token: "fvl_testtokentesttokentest" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code, o) => {
        res.statusCode = code;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(o));
      };
      const u = new URL(req.url, "http://x");
      if (u.pathname.startsWith("/blob/")) return res.end(blobs.get(u.pathname.slice(6)));
      if (req.headers.authorization !== `Bearer ${site.token}`) return json(401, { error: "Authentification requise", code: "unauthenticated" });
      if (u.pathname === "/api/launcher/latest") {
        const v = site.versions[u.searchParams.get("version") || site.current];
        const from = u.searchParams.get("from");
        const ti = site.order.indexOf(v.version);
        const fi = from ? site.order.indexOf(from) : -1;
        const relation = !from ? "install" : fi === ti ? "same" : fi >= 0 && fi < ti ? "upgrade" : "downgrade";
        const history = (relation === "upgrade" ? site.order.slice(fi + 1, ti + 1) : relation === "install" ? [v.version] : []).map((n) => ({
          version: n,
          title: site.versions[n].title,
          changes: site.versions[n].changes,
          sql: site.versions[n].sql,
        }));
        return json(200, Object.assign({}, v, { manifestSha256: F.manifestDigest(v.manifest), totalSize: 0, fileCount: v.manifest.files.length, relation, history }));
      }
      if (u.pathname === "/api/launcher/blobs") {
        const { hashes } = JSON.parse(body);
        return json(200, { urls: Object.fromEntries(hashes.map((h) => [h, `http://127.0.0.1:${site.port}/blob/${h}`])) });
      }
      if (u.pathname === "/api/launcher/report") {
        site.reports.push(JSON.parse(body));
        return json(200, { ok: true });
      }
      json(404, { error: "?" });
    });
  });
  site.chain = [];
  site.order = [];
  /** Publie une version : fichiers, motifs protégés, SQL de la version ({ nom: contenu }). */
  site.publish = (version, files, prot, sql) => {
    const all = Object.assign({}, files);
    for (const [name, content] of Object.entries(sql || {})) {
      const p = `sql/migrations/${version}/${name}`;
      site.chain.push({ version, name, path: p, sha256: sha(content), size: Buffer.byteLength(content) });
    }
    for (const m of site.chain) all[m.path] = all[m.path] || sqlContents.get(m.sha256);
    for (const [name, content] of Object.entries(sql || {})) {
      sqlContents.set(sha(content), content);
      all[`sql/migrations/${version}/${name}`] = content;
    }
    const list = Object.entries(all).map(([p, c]) => {
      blobs.set(sha(c), c);
      return { path: p, sha256: sha(c), size: Buffer.byteLength(c) };
    });
    site.versions[version] = {
      version,
      channel: "STABLE",
      title: `Version ${version}`,
      changes: [{ type: "NEW", text: `Nouveautés ${version}` }],
      sql: Object.keys(sql || {}),
      manifest: { files: list, managedDirs: ["resources", "sql"], protected: prot || ["server.cfg"], migrations: site.chain.slice() },
    };
    site.order.push(version);
    site.current = version;
  };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      site.port = server.address().port;
      site.url = `http://127.0.0.1:${site.port}`;
      server.unref();
      site.close = () => {
        server.close();
        if (server.closeAllConnections) server.closeAllConnections();
      };
      resolve(site);
    }),
  );
}

const V1 = { "server.cfg": "ensure fbm-updater", "resources/core/fxmanifest.lua": "fx_version 'cerulean'", "resources/core/main.lua": "v1" };
const V2 = Object.assign({}, V1, { "resources/core/main.lua": "v2", "resources/new/fxmanifest.lua": "fx" });

test("la commande fbm est enregistrée comme restreinte (permission command.fbm en jeu)", () => {
  const r = load({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "fbm-res-")) });
  assert.ok(r.st.commands.fbm);
  assert.strictEqual(r.st.commands.fbm.restricted, true);
});

test("sans configuration : explique quoi ajouter dans server.cfg", async () => {
  const r = load({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "fbm-res-")) });
  await r.cmd(0, ["update"]);
  assert.match(r.text(), /set fbm_api/);
  assert.match(r.text(), /set fbm_token/);
});

test("console txAdmin : status → update (préparée) → redémarrage (appliquée) → à jour", async () => {
  const site = await fakeSite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbm-res-"));
  const convars = { fbm_api: site.url, fbm_token: site.token };
  site.publish("1.0.0", V1);
  let r = load({ dir, convars });
  await r.cmd(0, ["status"]);
  assert.match(r.text(), /Installée : aucune/);
  assert.match(r.text(), /Disponible : v1\.0\.0/);

  await r.cmd(0, ["update"]);
  assert.match(r.text(), /v1\.0\.0 téléchargée et vérifiée/);
  assert.match(r.text(), /Redémarrez le serveur/);
  assert.ok(!fs.existsSync(path.join(dir, "resources/core/main.lua")), "rien n'est écrit avant le redémarrage");

  r.restart();
  assert.match(r.text(), /Mise à jour appliquée : v1\.0\.0/);
  assert.strictEqual(fs.readFileSync(path.join(dir, "resources/core/main.lua"), "utf8"), "v1");
  await new Promise((res) => setTimeout(res, 100));
  assert.deepStrictEqual(site.reports.pop(), { version: "1.0.0", kind: "INSTALL" });

  site.publish("1.1.0", V2);
  await r.cmd(0, ["update"]);
  assert.match(r.text(), /Préparation de v1\.1\.0 : 2 fichier\(s\) à télécharger/);
  assert.match(r.text(), /NEW\s+Nouveautés 1\.1\.0/);
  r.restart();
  assert.match(r.text(), /v1\.0\.0 → v1\.1\.0/);
  assert.strictEqual(fs.readFileSync(path.join(dir, "resources/core/main.lua"), "utf8"), "v2");

  await r.cmd(0, ["update"]);
  assert.match(r.text(), /Rien à faire : v1\.1\.0 est installée/);

  // retour à une version précise demandé par l'admin du serveur
  await r.cmd(0, ["update", "1.0.0"]);
  r.restart();
  assert.strictEqual(fs.readFileSync(path.join(dir, "resources/core/main.lua"), "utf8"), "v1");
  assert.ok(!fs.existsSync(path.join(dir, "resources/new")));
  site.close();
});

test("en jeu : réponses dans le chat du joueur, pas dans la console", async () => {
  const site = await fakeSite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbm-res-"));
  site.publish("1.0.0", V1);
  const r = load({ dir, convars: { fbm_api: site.url, fbm_token: site.token } });
  await r.cmd(7, ["status"]);
  assert.ok(r.st.chat.length > 0);
  assert.ok(r.st.chat.every((m) => m.ev === "chat:addMessage" && m.target === 7));
  assert.match(r.st.chat.map((m) => m.text).join("\n"), /Disponible : v1\.0\.0/);
  assert.ok(!/Disponible/.test(r.text()));
  await r.cmd(7, ["update"]);
  assert.match(r.text(), /joueur7 a lancé « fbm update » : v1\.0\.0/, "trace dans la console");
  site.close();
});

test("annulation, réparation, ressources déjà démarrées signalées, jeton refusé", async () => {
  const site = await fakeSite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbm-res-"));
  const convars = { fbm_api: site.url, fbm_token: site.token };
  site.publish("1.0.0", V1);
  const r = load({ dir, convars });
  await r.cmd(0, ["update"]);
  await r.cmd(0, ["cancel"]);
  assert.match(r.text(), /Mise à jour v1\.0\.0 annulée/);
  r.restart();
  assert.ok(!fs.existsSync(path.join(dir, "resources")));

  await r.cmd(0, ["update"]);
  r.restart();
  fs.writeFileSync(path.join(dir, "resources/core/main.lua"), "v9"); // même taille, contenu abîmé
  await r.cmd(0, ["repair"]);
  assert.match(r.text(), /1 fichier\(s\) à télécharger/);
  r.st.resourceStates.core = "started"; // la ressource « core » a démarré avant fbm-updater
  r.restart();
  assert.strictEqual(fs.readFileSync(path.join(dir, "resources/core/main.lua"), "utf8"), "v1");
  assert.match(r.text(), /core étai\(en\)t déjà démarrée/);
  assert.match(r.text(), /ensure fbm-updater » en PREMIER/);

  r.st.convars.fbm_token = "fvl_revoque_revoque_revoque";
  await r.cmd(0, ["status"]);
  assert.match(r.text(), /Jeton refusé/);
  site.close();
});

// ───────────────────────────── SQL (MariaDB / MySQL réel, ignoré s'il n'est pas joignable) ─────────────────────────────

const MYSQL = process.env.FBM_TEST_MYSQL || "mysql://fbm:fbm@127.0.0.1:3306/fivem_restest";
async function freshDb(t, name) {
  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch (e) {
    return t.skip("mysql2 absent"), null;
  }
  const u = new URL(MYSQL);
  const base = { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  try {
    const admin = await mysql.createConnection(base);
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.query(`CREATE DATABASE \`${name}\``);
    await admin.end();
    const conn = await mysql.createConnection(Object.assign({}, base, { database: name }));
    return { conn, db: { query: async (q, p) => (await conn.query(q, p))[0] } };
  } catch (e) {
    t.skip("pas de serveur MySQL/MariaDB joignable");
    return null;
  }
}

const BASE_SQL = { "001_base.sql": "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));\nINSERT INTO users VALUES (1, 'admin');" };
const GARAGE_SQL = { "001_garage.sql": "CREATE TABLE garages (id INT PRIMARY KEY, owner INT);\nALTER TABLE users ADD COLUMN money INT NOT NULL DEFAULT 500;" };

test("SQL : base vide → tout le SQL ; mise à jour → seulement le nouveau ; patch notes affichées", async (t) => {
  const c = await freshDb(t, "fivem_res_a");
  if (!c) return;
  const site = await fakeSite();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbm-res-"));
    const convars = { fbm_api: site.url, fbm_token: site.token };
    site.publish("1.0.0", V1, null, BASE_SQL);
    const r = load({ dir, convars, db: c.db });
    await r.cmd(0, ["update"]);
    assert.match(r.text(), /Base de données vide : installation complète du SQL/);
    assert.match(r.text(), /SQL exécuté : 1 fichier/);
    assert.deepStrictEqual((await c.db.query("SELECT name FROM users", [])).map((x) => x.name), ["admin"]);
    r.restart();
    assert.match(r.text(), /Mise à jour appliquée : v1\.0\.0/);
    assert.ok(fs.existsSync(path.join(dir, "sql/migrations/1.0.0/001_base.sql")));

    site.publish("1.1.0", V2, null, GARAGE_SQL);
    await r.cmd(0, ["status"]);
    assert.match(r.text(), /SQL : 1 fichier\(s\) à exécuter \(001_garage\.sql\)/);
    assert.match(r.text(), /Patch notes :\n.*v1\.1\.0 — Version 1\.1\.0\n.*NEW\s+Nouveautés 1\.1\.0\n.*SQL\s+001_garage\.sql/);
    await r.cmd(0, ["update"]);
    assert.match(r.text(), /SQL à exécuter : 1\.1\.0\/001_garage\.sql/);
    assert.ok(!/001_base\.sql \(/.test(r.text()), "le SQL déjà appliqué n'est pas ré-exécuté");
    assert.strictEqual((await c.db.query("SELECT money FROM users WHERE id = 1", []))[0].money, 500);
    r.restart();
    await r.cmd(0, ["sql"]);
    assert.match(r.text(), /Appliqués : 2  ·  En attente : 0/);
    await r.cmd(0, ["update"]);
    assert.match(r.text(), /Rien à faire/);
  } finally {
    site.close();
    await c.conn.end();
  }
});

test("SQL : base existante sans registre → baseline demandée, puis mise à jour normale", async (t) => {
  const c = await freshDb(t, "fivem_res_b");
  if (!c) return;
  const site = await fakeSite();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbm-res-"));
    const convars = { fbm_api: site.url, fbm_token: site.token };
    site.publish("1.0.0", V1, null, BASE_SQL);
    // serveur installé « à la main » (sans SQL) avec une base existante
    const r = load({ dir, convars, db: c.db, resourceStates: { oxmysql: "missing" } });
    await r.cmd(0, ["update"]);
    assert.match(r.text(), /oxmysql n'est pas démarré/);
    assert.strictEqual(F.readPending(dir), null, "fichiers non préparés sans le SQL");
    await c.db.query("CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50))", []);
    r.st.resourceStates.oxmysql = "started";
    await r.cmd(0, ["update"]);
    assert.match(r.text(), /sans registre fbm_migrations/);
    assert.match(r.text(), /fbm sql baseline/);
    assert.strictEqual(F.readPending(dir), null);

    r.st.convars.fbm_sql = "off";
    await r.cmd(0, ["update"]);
    assert.match(r.text(), /SQL non exécuté automatiquement \(fbm_sql off\)/);
    r.restart();
    delete r.st.convars.fbm_sql;
    await r.cmd(0, ["sql", "baseline"]);
    assert.match(r.text(), /1 fichier\(s\) SQL de v1\.0\.0 marqué\(s\) comme déjà appliqué/);
    site.publish("1.1.0", V2, null, GARAGE_SQL);
    await r.cmd(0, ["update"]);
    assert.match(r.text(), /SQL exécuté : 1 fichier/);
    assert.strictEqual((await c.db.query("SELECT COUNT(*) AS n FROM garages", []))[0].n, 0);
  } finally {
    site.close();
    await c.conn.end();
  }
});

test("SQL en échec : message précis, fichiers non appliqués au redémarrage", async (t) => {
  const c = await freshDb(t, "fivem_res_c");
  if (!c) return;
  const site = await fakeSite();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbm-res-"));
    const convars = { fbm_api: site.url, fbm_token: site.token };
    site.publish("1.0.0", V1, null, BASE_SQL);
    const r = load({ dir, convars, db: c.db });
    await r.cmd(0, ["update"]);
    r.restart();
    site.publish("1.1.0", V2, null, { "001_casse.sql": "ALTER TABLE table_inconnue ADD COLUMN x INT;" });
    await r.cmd(0, ["update"]);
    assert.match(r.text(), /Échec : SQL v1\.1\.0\/001_casse\.sql, instruction 1\/1/);
    assert.match(r.text(), /table_inconnue/);
    assert.match(r.text(), /Mise à jour des fichiers annulée/);
    r.restart();
    assert.ok(!/Mise à jour appliquée/.test(r.text()));
    assert.strictEqual(fs.readFileSync(path.join(dir, "resources/core/main.lua"), "utf8"), "v1");
  } finally {
    site.close();
    await c.conn.end();
  }
});
