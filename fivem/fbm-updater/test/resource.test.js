"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { load } = require("./harness");
const F = require("../server/engine.js");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Faux site : /api/launcher/latest, /blobs, /report et les blobs ; version courante modifiable. */
function fakeSite() {
  const blobs = new Map();
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
        return json(200, Object.assign({}, v, { manifestSha256: F.manifestDigest(v.manifest), totalSize: 0, fileCount: v.manifest.files.length }));
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
  site.publish = (version, files, prot) => {
    const list = Object.entries(files).map(([p, c]) => {
      blobs.set(sha(c), c);
      return { path: p, sha256: sha(c), size: Buffer.byteLength(c) };
    });
    site.versions[version] = {
      version,
      channel: "STABLE",
      title: `Version ${version}`,
      changes: [{ type: "NEW", text: `Nouveautés ${version}` }],
      manifest: { files: list, managedDirs: ["resources"], protected: prot || ["server.cfg"] },
    };
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
  assert.match(r.text(), /NEW  Nouveautés 1\.1\.0/);
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
  assert.match(r.text(), /joueur7 a préparé la mise à jour v1\.0\.0/, "trace dans la console");
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
