import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { processArchive, type ArchiveLimits } from "@/lib/archive/process";
import { LocalStorage } from "@/lib/storage/local";
import { blobKey } from "@/lib/storage/types";
import { makeZip, makeZipWithRawName } from "./helpers";

const limits: ArchiveLimits = {
  maxFiles: 100,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxRatio: 200,
  blockedExtensions: [".exe", ".bat", ".ps1"],
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let dir: string;
let storage: LocalStorage;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fbm-store-"));
  storage = new LocalStorage(dir, "x".repeat(40), "http://localhost:3000");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("processArchive", () => {
  it("stocke les blobs, calcule les SHA-256 et retire le dossier racine unique", async () => {
    const zip = await makeZip({
      "base/server.cfg": "endpoint_add_tcp",
      "base/resources/a/fxmanifest.lua": "fx_version 'cerulean'",
      "base/resources/b/copy.lua": "fx_version 'cerulean'", // contenu identique -> dédoublonné
    });
    const r = await processArchive(zip, storage, limits);
    expect(r.strippedRoot).toBe("base/");
    expect(r.files.map((f) => f.path)).toEqual(["server.cfg", "resources/a/fxmanifest.lua", "resources/b/copy.lua"]);
    expect(r.files[0].sha256).toBe(sha("endpoint_add_tcp"));
    expect(r.newBlobs).toBe(2);
    expect(r.reusedBlobs).toBe(1);
    expect(await storage.exists(blobKey(sha("fx_version 'cerulean'")))).toBe(true);
  });

  it("réutilise les blobs existants (mise à jour différentielle côté stockage)", async () => {
    const zip = await makeZip({ "server.cfg": "endpoint_add_tcp", "new.lua": "print(1)" });
    const r = await processArchive(zip, storage, limits);
    expect(r.newBlobs).toBe(1);
    expect(r.reusedBlobs).toBe(1);
  });

  it("refuse les chemins malveillants (zip slip)", async () => {
    for (const evil of ["../../evil.lua", "/abs/evil.lua!", "a\\b\\evil.lua!"]) {
      const zip = await makeZipWithRawName("x".repeat(evil.length), evil);
      await expect(processArchive(zip, storage, limits)).rejects.toThrow(/ZIP invalide|interdit|absolu/i);
    }
  });

  it("refuse les extensions bloquées", async () => {
    const zip = await makeZip({ "a/run.EXE": "MZ" });
    await expect(processArchive(zip, storage, limits)).rejects.toThrow(/Extension interdite/);
  });

  it("refuse les liens symboliques", async () => {
    const zip = await makeZip({ "a/link": { data: "/etc/passwd", mode: 0o120777 }, "a/x": "1" });
    await expect(processArchive(zip, storage, limits)).rejects.toThrow(/symbolique/);
  });

  it("refuse les doublons insensibles à la casse", async () => {
    const zip = await makeZip({ "A.lua": "1", "a.lua": "2" });
    await expect(processArchive(zip, storage, limits)).rejects.toThrow(/double/);
  });

  it("refuse une archive trop grosse (taille de fichier)", async () => {
    const zip = await makeZip({ "big.bin": Buffer.alloc(6 * 1024 * 1024, 1) });
    await expect(processArchive(zip, storage, limits)).rejects.toThrow(/volumineux/);
  });

  it("refuse un ratio de compression suspect", async () => {
    const zip = await makeZip({ "bomb.txt": Buffer.alloc(4 * 1024 * 1024, 0) });
    await expect(processArchive(zip, storage, { ...limits, maxRatio: 50 })).rejects.toThrow(/zip bomb|Ratio/);
  });

  it("refuse trop de fichiers", async () => {
    const zip = await makeZip({ "a": "1", "b": "2", "c": "3" });
    await expect(processArchive(zip, storage, { ...limits, maxFiles: 2 })).rejects.toThrow(/Trop de fichiers/);
  });

  it("refuse un fichier qui n'est pas un ZIP", async () => {
    const dirx = await mkdtemp(path.join(tmpdir(), "fbm-bad-"));
    const bad = path.join(dirx, "bad.zip");
    await (await import("node:fs/promises")).writeFile(bad, "pas un zip du tout, vraiment pas");
    await expect(processArchive(bad, storage, limits)).rejects.toThrow(/ZIP invalide/);
  });
});

describe("LocalStorage", () => {
  it("refuse les clés qui sortent de la racine", async () => {
    await expect(storage.exists("../../etc/passwd")).resolves.toBe(false);
    await expect(storage.get("../x")).rejects.toThrow();
  });
});
