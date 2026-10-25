import { describe, expect, it } from "vitest";
import { buildManifest, diffManifests, globToRegExp, isProtected, manifestDigest } from "@/lib/manifest";

const f = (path: string, sha256: string, size = 10) => ({ path, sha256, size });

describe("manifest", () => {
  it("trie les fichiers et déduit managedDirs", () => {
    const m = buildManifest([f("resources/b.lua", "b"), f("server.cfg", "c"), f("resources/a.lua", "a"), f("[core]/x", "x")]);
    expect(m.files.map((x) => x.path)).toEqual(["[core]/x", "resources/a.lua", "resources/b.lua", "server.cfg"]);
    expect(m.managedDirs).toEqual(["[core]", "resources"]);
  });

  it("diff: ajouts, modifications, suppressions", () => {
    const prev = buildManifest([f("a", "1", 5), f("b", "2", 6), f("c", "3", 7)]);
    const next = buildManifest([f("a", "1", 5), f("b", "9", 8), f("d", "4", 3)]);
    const d = diffManifests(prev, next);
    expect(d.added.map((x) => x.path)).toEqual(["d"]);
    expect(d.modified.map((x) => x.path)).toEqual(["b"]);
    expect(d.removed.map((x) => x.path)).toEqual(["c"]);
    expect(d.unchanged).toBe(1);
    expect(d.downloadSize).toBe(11);
  });

  it("diff sans version précédente = tout est ajouté", () => {
    const d = diffManifests(null, buildManifest([f("a", "1"), f("b", "2")]));
    expect(d.added).toHaveLength(2);
  });

  it("digest indépendant de l'ordre d'insertion", () => {
    const a = buildManifest([f("a", "1"), f("b", "2")]);
    const b = buildManifest([f("b", "2"), f("a", "1")]);
    expect(manifestDigest(a)).toBe(manifestDigest(b));
    expect(manifestDigest(a)).not.toBe(manifestDigest(buildManifest([f("a", "1"), f("b", "3")])));
  });

  it("glob de fichiers protégés", () => {
    const p = ["server.cfg", "**/config.lua", "txData/**", "**/*.local.*"];
    expect(isProtected("server.cfg", p)).toBe(true);
    expect(isProtected("SERVER.CFG", p)).toBe(true);
    expect(isProtected("resources/x/config.lua", p)).toBe(true);
    expect(isProtected("config.lua", p)).toBe(true);
    expect(isProtected("txData/a/b.json", p)).toBe(true);
    expect(isProtected("resources/x/a.local.json", p)).toBe(true);
    expect(isProtected("resources/x/client.lua", p)).toBe(false);
    expect(isProtected("resources/server.cfg.bak", p)).toBe(false);
  });

  it("globToRegExp échappe les métacaractères", () => {
    expect(globToRegExp("a+b(1).lua").test("a+b(1).lua")).toBe(true);
    expect(globToRegExp("a+b(1).lua").test("aab(1).lua")).toBe(false);
  });
});
