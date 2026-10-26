"use strict";
/**
 * SQL : mêmes cas de découpage que le site + exécution réelle sur MariaDB/MySQL (si disponible).
 * Base de test : FBM_TEST_MYSQL=mysql://fbm:fbm@127.0.0.1:3306/fivem_sqltest (défaut). Sans serveur MySQL, ces tests sont ignorés.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const F = require("../fbm-updater/server/engine.js");
const cases = require("../../web/tests/sql-cases.json");

for (const c of cases) {
  test(`découpage : ${c.name}`, () => {
    const r = F.splitSql(c.sql);
    assert.deepStrictEqual(r.statements, c.statements);
    assert.strictEqual(r.trailing, c.trailing);
    assert.strictEqual(r.usesDelimiter, !!c.usesDelimiter);
  });
}

test("registre identique à celui de sql/install.sql (site)", () => {
  const web = fs.readFileSync(path.join(__dirname, "../../web/src/lib/release.ts"), "utf8");
  const ddl = /export const LEDGER_DDL = `([\s\S]*?)`;/.exec(web)[1].replace(/\\`/g, "`").replace(/\$\{LEDGER_TABLE\}/g, "fbm_migrations");
  assert.strictEqual(F.LEDGER_DDL, ddl);
});

const URL_ = process.env.FBM_TEST_MYSQL || "mysql://fbm:fbm@127.0.0.1:3306/fivem_sqltest";
let mysql = null;
try {
  mysql = require("mysql2/promise");
} catch (e) {
  mysql = null;
}

/** Recrée la base de test ; retourne null si aucun serveur MySQL n'est joignable. */
async function connect() {
  if (!mysql) return null;
  const u = new URL(URL_);
  const dbName = u.pathname.slice(1);
  const base = { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  try {
    const admin = await mysql.createConnection(base);
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\``);
    await admin.end();
    const conn = await mysql.createConnection(Object.assign({}, base, { database: dbName }));
    return { conn, db: { query: async (sql, params) => (await conn.query(sql, params))[0] } };
  } catch (e) {
    return null;
  }
}

function migrations(dir, version, files) {
  return Object.entries(files).map(([name, content]) => {
    const p = `sql/migrations/${version}/${name}`;
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
    return { version, name, path: p, sha256: crypto.createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) };
  });
}

test("exécution réelle : base vide, registre, une seule exécution, erreurs claires, baseline", async (t) => {
  const c = await connect();
  if (!c) return t.skip("pas de serveur MySQL/MariaDB joignable");
  const { db, conn } = c;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbm-sql-"));
    const v1 = migrations(dir, "1.0.0", {
      "001_base.sql": "-- base\nCREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));\nINSERT INTO users VALUES (1, 'a;b'), (2, 'c''d');\n/*!40101 SET NAMES utf8mb4 */;\n",
      "002_trigger.sql":
        "DELIMITER $$\nCREATE TRIGGER users_bi BEFORE INSERT ON users FOR EACH ROW BEGIN SET NEW.name = UPPER(NEW.name); SET NEW.name = TRIM(NEW.name); END$$\nDELIMITER ;\n",
    });
    let st = await F.sqlStatus(db, v1);
    assert.deepStrictEqual([st.ledger, st.emptyDb, st.pending.length], [null, true, 2]);
    assert.strictEqual(await F.runSql(dir, db, st.pending), 2);
    await db.query("INSERT INTO users (id, name) VALUES (3, ' x ')", []);
    assert.deepStrictEqual(
      (await db.query("SELECT name FROM users ORDER BY id", [])).map((r) => r.name),
      ["a;b", "c'd", "X"],
      "chaînes avec ; et '' intactes, trigger (DELIMITER) actif",
    );

    st = await F.sqlStatus(db, v1);
    assert.deepStrictEqual([st.ledger, st.pending.length], [2, 0], "une seule exécution");

    const v2 = v1.concat(migrations(dir, "1.1.0", { "001_garage.sql": "CREATE TABLE garages (id INT);\nALTER TABLE users ADD COLUMN money INT NOT NULL DEFAULT 0" }));
    st = await F.sqlStatus(db, v2);
    assert.deepStrictEqual(st.pending.map((m) => m.name), ["001_garage.sql"]);
    await F.runSql(dir, db, st.pending);
    assert.strictEqual((await db.query("SELECT money FROM users WHERE id = 1", []))[0].money, 0);

    // erreur : message clair, fichier non inscrit au registre
    const bad = migrations(dir, "1.2.0", { "001_bad.sql": "CREATE TABLE ok_avant (id INT);\nALTER TABLE n_existe_pas ADD COLUMN x INT;" });
    await assert.rejects(
      F.runSql(dir, db, bad),
      (e) => e.code === "sql" && /instruction 2\/2/.test(e.message) && /n_existe_pas/.test(e.message) && /1 instruction\(s\) précédente\(s\)/.test(e.message),
    );
    assert.strictEqual((await F.sqlStatus(db, bad)).pending.length, 1);

    // fichier SQL local modifié : refus d'exécuter
    fs.writeFileSync(path.join(dir, v2[2].path), "DROP TABLE users;");
    await assert.rejects(F.runSql(dir, db, [Object.assign({}, v2[2], { version: "9.9.9" })]), (e) => e.code === "integrity");
    assert.ok((await db.query("SELECT COUNT(*) AS n FROM users", []))[0].n > 0);

    // base existante sans registre : baseline
    await db.query("DROP TABLE fbm_migrations", []);
    st = await F.sqlStatus(db, v2);
    assert.deepStrictEqual([st.ledger, st.emptyDb], [null, false]);
    assert.strictEqual(await F.baselineSql(db, v2), 3);
    assert.strictEqual((await F.sqlStatus(db, v2)).pending.length, 0);
  } finally {
    await conn.end();
  }
});
