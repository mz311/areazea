import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import yauzl from "yauzl";
import { processArchive, type ArchiveLimits } from "@/lib/archive/process";
import { buildArchive, buildRelease, INSTALL_SQL } from "@/lib/release";
import { splitSql } from "@/lib/sql";
import type { Manifest } from "@/lib/manifest";
import { LocalStorage } from "@/lib/storage/local";
import { blobKey } from "@/lib/storage/types";
import { makeZip } from "./helpers";

const limits: ArchiveLimits = { maxFiles: 1000, maxFileBytes: 10 << 20, maxTotalBytes: 50 << 20, maxRatio: 500, blockedExtensions: [".exe"] };
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

let dir: string;
let st: LocalStorage;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fbm-release-"));
  st = new LocalStorage(dir, "x".repeat(40), "http://localhost");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function release(version: string, mode: "full" | "patch", files: Record<string, string>, parent: Manifest | null, deletes: string[] = [], stripRoot = false) {
  const zip = await makeZip(files);
  const p = await processArchive(zip, st, limits, { stripRoot });
  return buildRelease({ version, mode, parent: parent ? { version: "parent", manifest: parent } : null, files: p.files, deletePatterns: deletes, siteName: "Ma Base" }, st);
}

const text = async (sha256: string) => {
  const o = await st.get(blobKey(sha256));
  const chunks: Buffer[] = [];
  for await (const c of o.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};
const file = (m: Manifest, p: string) => m.files.find((f) => f.path === p);

const BASE_SQL = "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));\nINSERT INTO users VALUES (1, 'a;b')";
let v1: Manifest;

describe("base complète", () => {
  it("range _sql/ dans l'historique et génère sql/install.sql", async () => {
    const r = await release("1.0.0", "full", {
      "server.cfg": "ensure core",
      "resources/core/fxmanifest.lua": "fx",
      "resources/core/main.lua": "v1",
      "resources/old/fxmanifest.lua": "old",
      "resources/old/x.bak": "bak",
      "_sql/001_base.sql": BASE_SQL,
    }, null);
    v1 = r.manifest;
    const paths = v1.files.map((f) => f.path);
    expect(paths).toContain("sql/migrations/1.0.0/001_base.sql");
    expect(paths).toContain(INSTALL_SQL);
    expect(paths.some((p) => p.startsWith("_sql/"))).toBe(false);
    expect(v1.migrations).toEqual([expect.objectContaining({ version: "1.0.0", name: "001_base.sql", path: "sql/migrations/1.0.0/001_base.sql", sha256: sha(BASE_SQL) })]);
    expect(v1.managedDirs).toEqual(["resources", "sql"]);
    const install = await text(file(v1, INSTALL_SQL)!.sha256);
    expect(install).toContain("Importez ce fichier UNE SEULE FOIS");
    expect(install).toContain("INSERT INTO users VALUES (1, 'a;b');"); // point-virgule final ajouté
    expect(install).toMatch(/INSERT IGNORE INTO `fbm_migrations`[\s\S]*\('1\.0\.0', '001_base\.sql', '[a-f0-9]{64}'\);/);
    const stmts = splitSql(install).statements;
    expect(stmts).toHaveLength(4); // CREATE, INSERT, CREATE registre, INSERT registre
    expect(splitSql(install).trailing).toBe(false);
    expect(r.summary.migrations.map((m) => m.name)).toEqual(["001_base.sql"]);
  });

  it("refuse les suppressions sur une base complète", async () => {
    await expect(release("9.0.0", "full", { "a.lua": "1" }, null, ["resources/old"])).rejects.toThrow(/patchs/);
  });
});

describe("patch", () => {
  let v11: Manifest;
  it("fusionne les fichiers modifiés, applique les suppressions et prolonge l'historique SQL", async () => {
    const r = await release(
      "1.1.0",
      "patch",
      {
        "resources/core/main.lua": "v2",
        "resources/garage/fxmanifest.lua": "garage",
        "_sql/002_garage.sql": "CREATE TABLE garages (id INT);",
        "_sql/010_index.sql": "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\n",
        "fbm-delete.txt": "# commentaire\nresources/old\n\n**/*.bak\nresources/inexistant.lua\n",
      },
      v1,
      ["resources/rien/**"],
    );
    v11 = r.manifest;
    const paths = v11.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["server.cfg", "resources/core/main.lua", "resources/garage/fxmanifest.lua", "resources/core/fxmanifest.lua"]));
    expect(paths.some((p) => p.startsWith("resources/old/"))).toBe(false);
    expect(paths).not.toContain("fbm-delete.txt");
    expect(file(v11, "resources/core/main.lua")!.sha256).toBe(sha("v2"));
    expect(file(v11, "server.cfg")!.sha256).toBe(sha("ensure core"));
    expect(r.deleted).toBe(2);
    expect(r.unmatchedDeletes).toEqual(["resources/rien/**", "resources/inexistant.lua"]);
    expect(v11.migrations!.map((m) => `${m.version}/${m.name}`)).toEqual(["1.0.0/001_base.sql", "1.1.0/002_garage.sql", "1.1.0/010_index.sql"]);
    expect(paths).toEqual(expect.arrayContaining(["sql/migrations/1.0.0/001_base.sql", "sql/migrations/1.1.0/002_garage.sql"]));
    expect(r.summary.counts).toMatchObject({ added: 1, modified: 1, removed: 2 });
    expect(r.summary.resources).toEqual(["core", "garage", "old"]);
    expect(r.summary.migrations.map((m) => m.name)).toEqual(["002_garage.sql", "010_index.sql"]);
    // install.sql : tout l'historique, dans l'ordre, DELIMITER rétabli
    const install = await text(file(v11, INSTALL_SQL)!.sha256);
    expect(install.indexOf("CREATE TABLE users")).toBeLessThan(install.indexOf("CREATE TABLE garages"));
    expect(install).toMatch(/END\$\$\nDELIMITER ;/);
    const split = splitSql(install);
    expect(split.statements.some((s) => s.startsWith("CREATE PROCEDURE p() BEGIN SELECT 1; END"))).toBe(true);
    expect(split.endDelimiter).toBe(";");
    expect(install).toContain("('1.1.0', '010_index.sql'");
  });

  it("garde les réglages du launcher de la version parente", async () => {
    const custom: Manifest = { ...v1, managedDirs: ["resources"], protected: ["server.cfg", "resources/core/config.lua"] };
    const r = await release("1.1.1", "patch", { "stream/car.ytd": "ytd" }, custom);
    expect(r.manifest.protected).toEqual(["server.cfg", "resources/core/config.lua"]);
    expect(r.manifest.managedDirs).toEqual(["resources", "stream"]); // « sql » retiré par l'admin reste retiré, « stream » est nouveau
  });

  it("refuse les fichiers SQL mal placés et les fichiers générés", async () => {
    await expect(release("1.2.0", "patch", { "_sql/sous/x.sql": "x" }, v1)).rejects.toThrow(/_sql/);
    await expect(release("1.2.0", "patch", { "_sql/x.txt": "x" }, v1)).rejects.toThrow(/_sql/);
    await expect(release("1.2.0", "patch", { "sql/install.sql": "x" }, v1)).rejects.toThrow(/généré/);
    await expect(release("1.2.0", "patch", { "a.lua": "x" }, null)).rejects.toThrow(/base/);
    await expect(release("1.2.0", "patch", { "a.lua": "x" }, v1, ["../etc"])).rejects.toThrow(/invalide/);
  });

  it("reconstruit un ZIP complet identique au manifeste", async () => {
    const built = await buildArchive(v11, st);
    try {
      const entries = await new Promise<Map<string, string>>((resolve, reject) => {
        const out = new Map<string, string>();
        yauzl.open(built.file, { lazyEntries: true }, (err, z) => {
          if (err || !z) return reject(err);
          z.on("entry", (e: yauzl.Entry) =>
            z.openReadStream(e, (er, s) => {
              if (er || !s) return reject(er);
              const h = createHash("sha256");
              s.on("data", (c) => h.update(c));
              s.on("end", () => {
                out.set(e.fileName, h.digest("hex"));
                z.readEntry();
              });
            }),
          );
          z.on("end", () => resolve(out));
          z.readEntry();
        });
      });
      expect(entries.size).toBe(v11.files.length);
      for (const f of v11.files) expect(entries.get(f.path)).toBe(f.sha256);
      expect(built.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await built.cleanup();
    }
  });
});
