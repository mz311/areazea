/**
 * Construction d'une version à partir d'une archive envoyée par l'admin :
 *  - FULL  : l'archive EST la base (sauf le SQL, rangé dans l'historique) ;
 *  - PATCH : l'archive ne contient que les fichiers modifiés, fusionnés sur la version parente.
 *
 * Conventions dans l'archive :
 *  - `_sql/*.sql`      : SQL de CETTE version (exécuté une fois par serveur, par ordre de nom) ;
 *  - `fbm-delete.txt`  : fichiers / dossiers / motifs à supprimer de la base (patch uniquement).
 *
 * Générés automatiquement dans la base : `sql/migrations/<version>/<nom>.sql` (tout l'historique) et
 * `sql/install.sql` (base de données complète à importer une fois, avec le registre fbm_migrations).
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { ArchiveError, normalizeEntryPath } from "./archive/paths";
import { buildManifest, DEFAULT_PROTECTED, diffManifests, globToRegExp, type Manifest, type ManifestFile, type Migration } from "./manifest";
import { splitSql } from "./sql";
import { blobKey, type Storage } from "./storage/types";

export const INSTALL_SQL = "sql/install.sql";
export const MIGRATIONS_DIR = "sql/migrations/";
export const SQL_INBOX = "_sql/";
export const DELETE_LIST = "fbm-delete.txt";
export const LEDGER_TABLE = "fbm_migrations";

const MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.sql$/;
const isGenerated = (p: string) => {
  const l = p.toLowerCase();
  return l === INSTALL_SQL || l.startsWith(MIGRATIONS_DIR);
};

export interface DiffSummary {
  counts: { added: number; modified: number; removed: number; unchanged: number };
  added: string[];
  modified: string[];
  removed: string[];
  /** Les listes ci-dessus sont tronquées au-delà de LIST_LIMIT entrées. */
  truncated: boolean;
  /** SQL ajouté par cette version. */
  migrations: { name: string; path: string; size: number }[];
  /** Ressources FiveM touchées (dossier contenant le fichier, sous resources/). */
  resources: string[];
}

export interface ReleaseResult {
  manifest: Manifest;
  summary: DiffSummary;
  /** Motifs de suppression qui ne correspondaient à aucun fichier. */
  unmatchedDeletes: string[];
  deleted: number;
}

const LIST_LIMIT = 500;

async function readBlob(storage: Storage, sha256: string): Promise<Buffer> {
  const obj = await storage.get(blobKey(sha256));
  const chunks: Buffer[] = [];
  for await (const c of obj.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function parseDeleteList(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Motif de suppression → prédicat. Un chemin sans joker désigne un fichier OU un dossier entier. */
function deleteMatcher(pattern: string): (p: string) => boolean {
  const pat = pattern.replace(/\/+$/, "");
  if (!pat || pat.startsWith("/") || pat.includes("\\") || pat.split("/").includes("..")) {
    throw new ArchiveError(`Motif de suppression invalide : "${pattern}"`);
  }
  if (/[*?]/.test(pat)) {
    const re = globToRegExp(pat);
    return (p) => re.test(p);
  }
  const lower = pat.toLowerCase();
  return (p) => {
    const l = p.toLowerCase();
    return l === lower || l.startsWith(lower + "/");
  };
}

/** Ressource FiveM « probable » d'un chemin : premier dossier sous resources/ qui n'est pas une catégorie [xxx]. */
function resourceOf(p: string): string | null {
  const parts = p.split("/");
  if (parts[0]?.toLowerCase() !== "resources") return null;
  for (let i = 1; i < parts.length - 1; i++) if (!/^\[.*\]$/.test(parts[i])) return parts[i];
  return null;
}

export async function buildRelease(
  input: {
    version: string;
    mode: "full" | "patch";
    parent: { version: string; manifest: Manifest } | null;
    files: ManifestFile[];
    deletePatterns: string[];
    siteName: string;
  },
  storage: Storage,
): Promise<ReleaseResult> {
  const { version, mode, parent } = input;
  if (mode === "patch" && !parent) throw new ArchiveError("Un patch a besoin d'une version de base : publiez d'abord une base complète");

  // 1. entrées spéciales de l'archive
  const ownMigrations: Migration[] = [];
  const regular: ManifestFile[] = [];
  const deletePatterns = [...input.deletePatterns];
  for (const f of input.files) {
    const lower = f.path.toLowerCase();
    if (lower.startsWith(SQL_INBOX)) {
      const name = f.path.slice(SQL_INBOX.length);
      if (name.includes("/") || !MIGRATION_NAME.test(name)) {
        throw new ArchiveError(`Fichier SQL invalide « ${f.path} » : placez des fichiers .sql directement dans _sql/ (lettres, chiffres, . _ -)`);
      }
      const p = `${MIGRATIONS_DIR}${version}/${name}`;
      normalizeEntryPath(p);
      ownMigrations.push({ version, name, path: p, sha256: f.sha256, size: f.size });
    } else if (lower === DELETE_LIST) {
      deletePatterns.push(...parseDeleteList((await readBlob(storage, f.sha256)).toString("utf8")));
    } else if (isGenerated(f.path)) {
      throw new ArchiveError(`« ${f.path} » est généré automatiquement : mettez votre SQL dans _sql/`);
    } else regular.push(f);
  }
  ownMigrations.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  if (mode === "full" && deletePatterns.length) {
    throw new ArchiveError("Les suppressions ne concernent que les patchs : une base complète remplace déjà tous les fichiers");
  }

  // 2. fichiers : base complète, ou version parente − suppressions + fichiers du patch
  const files = new Map<string, ManifestFile>();
  let deleted = 0;
  const unmatchedDeletes: string[] = [];
  if (mode === "patch") {
    for (const f of parent!.manifest.files) if (!isGenerated(f.path)) files.set(f.path, f);
    // chaque motif est évalué sur la version parente (un motif couvert par un autre n'est pas signalé « sans effet »)
    const before = [...files.keys()];
    const doomed = new Set<string>();
    for (const pattern of deletePatterns) {
      const match = deleteMatcher(pattern);
      const hits = before.filter((p) => match(p));
      if (!hits.length) unmatchedDeletes.push(pattern);
      hits.forEach((p) => doomed.add(p));
    }
    doomed.forEach((p) => files.delete(p));
    deleted = doomed.size;
  }
  for (const f of regular) {
    // un fichier du patch remplace celui de la base même si la casse diffère (Windows)
    for (const k of files.keys()) if (k !== f.path && k.toLowerCase() === f.path.toLowerCase()) files.delete(k);
    files.set(f.path, f);
  }

  // 3. historique SQL : celui de la parente + celui de cette version
  const chain = [...(parent?.manifest.migrations ?? []), ...ownMigrations];
  for (const m of chain) files.set(m.path, { path: m.path, sha256: m.sha256, size: m.size });
  if (chain.length) {
    const install = await buildInstallSql(chain, version, input.siteName, storage);
    files.set(INSTALL_SQL, { path: INSTALL_SQL, ...install });
  }
  if (!files.size) throw new ArchiveError("La version ne contient aucun fichier");

  // 4. manifeste : réglages du launcher hérités de la parente ; les nouveaux dossiers racine sont gérés
  const list = [...files.values()];
  const topDir = (p: string) => (p.includes("/") ? p.split("/")[0] : null);
  const parentTops = new Set((parent?.manifest.files ?? []).map((f) => topDir(f.path)?.toLowerCase()));
  const newTops = [...new Set(list.map((f) => topDir(f.path)).filter((t): t is string => !!t && !parentTops.has(t.toLowerCase())))];
  const managedDirs = parent ? [...new Set([...parent.manifest.managedDirs, ...newTops])].sort() : undefined;
  const manifest = buildManifest(list, { managedDirs, protected: parent?.manifest.protected ?? DEFAULT_PROTECTED });
  manifest.migrations = chain;

  // 5. résumé pour les patch notes
  const d = diffManifests(parent?.manifest ?? null, manifest);
  const visible = (f: { path: string }) => f.path !== INSTALL_SQL && !f.path.startsWith(MIGRATIONS_DIR);
  const added = d.added.filter(visible).map((f) => f.path);
  const modified = d.modified.filter(visible).map((f) => f.path);
  const removed = d.removed.filter(visible).map((f) => f.path);
  const resources = new Set<string>();
  for (const p of [...added, ...modified, ...removed]) {
    const r = resourceOf(p);
    if (r) resources.add(r);
  }
  const summary: DiffSummary = {
    counts: { added: added.length, modified: modified.length, removed: removed.length, unchanged: d.unchanged },
    added: added.slice(0, LIST_LIMIT),
    modified: modified.slice(0, LIST_LIMIT),
    removed: removed.slice(0, LIST_LIMIT),
    truncated: Math.max(added.length, modified.length, removed.length) > LIST_LIMIT,
    migrations: ownMigrations.map((m) => ({ name: m.name, path: m.path, size: m.size })),
    resources: [...resources].sort(),
  };
  return { manifest, summary, unmatchedDeletes, deleted };
}

const sqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS \`${LEDGER_TABLE}\` (
  \`version\` VARCHAR(64) NOT NULL,
  \`name\` VARCHAR(191) NOT NULL,
  \`sha256\` CHAR(64) NOT NULL,
  \`applied_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`version\`, \`name\`)
)`;

/** Concatène tout l'historique SQL en un script à importer une fois sur une base de données vide. */
export async function buildInstallSql(chain: Migration[], version: string, siteName: string, storage: Storage): Promise<{ sha256: string; size: number }> {
  const parts: string[] = [
    "-- =====================================================================",
    `-- ${siteName} v${version} : base de données complète`,
    "-- Importez ce fichier UNE SEULE FOIS sur une base de données VIDE",
    "-- (HeidiSQL : Fichier > Charger un fichier SQL puis Exécuter ; phpMyAdmin : Importer).",
    `-- Il contient le SQL de toutes les versions jusqu'à v${version}, dans l'ordre.`,
    "-- Les mises à jour suivantes sont appliquées par la commande « fbm update ».",
    "-- Fichier généré automatiquement : ne le modifiez pas.",
    "-- =====================================================================",
    "",
  ];
  for (const m of chain) {
    const text = (await readBlob(storage, m.sha256)).toString("utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const split = splitSql(text);
    // une dernière instruction sans délimiteur se collerait à la suivante : on le rajoute
    parts.push(`-- ----- v${m.version} / ${m.name} -----`, text.trimEnd() + (split.trailing ? split.endDelimiter : ""));
    if (split.usesDelimiter && split.endDelimiter !== ";") parts.push("DELIMITER ;");
    parts.push("");
  }
  parts.push(
    "-- ----- registre des fichiers SQL appliqués (utilisé par fbm update) -----",
    `${LEDGER_DDL};`,
    `INSERT IGNORE INTO \`${LEDGER_TABLE}\` (\`version\`, \`name\`, \`sha256\`) VALUES`,
    chain.map((m) => `  (${sqlString(m.version)}, ${sqlString(m.name)}, ${sqlString(m.sha256)})`).join(",\n") + ";",
    "",
  );
  const buf = Buffer.from(parts.join("\n"), "utf8");
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (!(await storage.exists(blobKey(sha256)))) await storage.putBuffer(blobKey(sha256), buf, "application/sql");
  return { sha256, size: buf.length };
}

/** Formats déjà compressés : stockés tels quels dans le ZIP (plus rapide, aucun gain à recompresser). */
const STORED = new Set([".ytd", ".ydr", ".yft", ".ydd", ".ybn", ".ymap", ".ytyp", ".ycd", ".rpf", ".awc", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ogg", ".mp3", ".mp4", ".webm", ".zip", ".7z", ".rar", ".gz"]);

/** Reconstruit le ZIP complet « prêt à lancer » à partir des blobs du manifeste (fichiers lus un par un). */
export async function buildArchive(manifest: Manifest, storage: Storage): Promise<{ file: string; sha256: string; size: number; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "fbm-archive-"));
  const file = path.join(dir, "base.zip");
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const zip = new yazl.ZipFile();
    for (const f of manifest.files) {
      const ext = path.extname(f.path).toLowerCase();
      zip.addReadStreamLazy(f.path, { size: f.size, compress: !STORED.has(ext) }, (cb) => {
        storage.get(blobKey(f.sha256)).then(
          (o) => cb(null, o.stream),
          (e) => cb(e as Error, undefined as never),
        );
      });
    }
    zip.end();
    const hash = createHash("sha256");
    const tap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(zip.outputStream, tap, createWriteStream(file));
    return { file, sha256: hash.digest("hex"), size: (await stat(file)).size, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

