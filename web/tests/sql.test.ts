import { describe, expect, it } from "vitest";
import cases from "./sql-cases.json";
import { splitSql } from "@/lib/sql";

describe("splitSql", () => {
  for (const c of cases as { name: string; sql: string; statements: string[]; trailing: boolean; usesDelimiter?: boolean }[]) {
    it(c.name, () => {
      const r = splitSql(c.sql);
      expect(r.statements).toEqual(c.statements);
      expect(r.trailing).toBe(c.trailing);
      expect(r.usesDelimiter).toBe(!!c.usesDelimiter);
    });
  }
});
