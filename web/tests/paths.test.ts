import { describe, expect, it } from "vitest";
import { ArchiveError, commonRoot, extensionOf, normalizeEntryPath } from "@/lib/archive/paths";

describe("normalizeEntryPath", () => {
  it.each(["resources/a/fxmanifest.lua", "server.cfg", "[core]/x/y.lua", "é/ü.txt"])("accepte %s", (p) => {
    expect(normalizeEntryPath(p)).toBe(p.normalize("NFC"));
  });

  it.each([
    "../evil.lua",
    "a/../../evil",
    "/etc/passwd",
    "C:/Windows/x",
    "c:evil",
    "a\\b",
    "a//b",
    "./a",
    "a/./b",
    "CON",
    "a/nul.txt",
    "dir/file.",
    "dir /file",
    "a/b:stream",
    ".fbm/state.json",
    "a/\u0001b",
    "",
  ])("refuse %j", (p) => {
    expect(() => normalizeEntryPath(p)).toThrow(ArchiveError);
  });

  it("refuse un chemin trop long", () => {
    expect(() => normalizeEntryPath("a/".repeat(130) + "b")).toThrow(ArchiveError);
  });
});

describe("helpers", () => {
  it("commonRoot", () => {
    expect(commonRoot(["base/a", "base/b/c"])).toBe("base/");
    expect(commonRoot(["base/a", "other/b"])).toBeNull();
    expect(commonRoot(["a", "base/b"])).toBeNull();
  });
  it("extensionOf", () => {
    expect(extensionOf("a/b/Run.EXE")).toBe(".exe");
    expect(extensionOf("a/.gitignore")).toBe("");
    expect(extensionOf("a/b")).toBe("");
  });
});
