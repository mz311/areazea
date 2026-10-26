import { sha256Hex } from "./crypto";

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

/** Fichier SQL d'une version, exécuté une seule fois par serveur, dans l'ordre de l'historique. */
export interface Migration {
  version: string;
  name: string;
  /** Emplacement dans la base : sql/migrations/<version>/<name> */
  path: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  files: ManifestFile[];
  /** Dossiers racine dont le launcher peut supprimer les fichiers obsolètes qu'il a lui-même installés. */
  managedDirs: string[];
  /** Motifs glob des fichiers de configuration utilisateur : jamais écrasés, jamais supprimés. */
  protected: string[];
  /** Historique SQL complet jusqu'à cette version (de la plus ancienne à la plus récente). Hors empreinte. */
  migrations?: Migration[];
}

export const DEFAULT_PROTECTED = [
  "server.cfg",
  "**/config.lua",
  "**/config.json",
  "**/config.cfg",
  "**/*.local.*",
  "txData/**",
  "cache/**",
];

export function buildManifest(
  files: ManifestFile[],
  opts: { managedDirs?: string[]; protected?: string[] } = {},
): Manifest {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const top = new Set<string>();
  for (const f of sorted) {
    const i = f.path.indexOf("/");
    if (i > 0) top.add(f.path.slice(0, i));
  }
  return {
    files: sorted,
    managedDirs: opts.managedDirs ?? [...top].sort(),
    protected: opts.protected ?? DEFAULT_PROTECTED,
  };
}

/** Empreinte canonique d'un manifeste (ordre des clés fixe). */
export function manifestDigest(m: Manifest): string {
  const canonical = JSON.stringify({
    files: m.files.map((f) => [f.path, f.sha256, f.size]),
    managedDirs: m.managedDirs,
    protected: m.protected,
  });
  return sha256Hex(canonical);
}

export interface ManifestDiff {
  added: ManifestFile[];
  modified: ManifestFile[];
  removed: ManifestFile[];
  unchanged: number;
  /** Octets à télécharger pour passer de prev à next (fichiers ajoutés ou modifiés). */
  downloadSize: number;
}

export function diffManifests(prev: Manifest | null, next: Manifest): ManifestDiff {
  const before = new Map((prev?.files ?? []).map((f) => [f.path, f]));
  const after = new Map(next.files.map((f) => [f.path, f]));
  const added: ManifestFile[] = [];
  const modified: ManifestFile[] = [];
  let unchanged = 0;
  for (const f of next.files) {
    const old = before.get(f.path);
    if (!old) added.push(f);
    else if (old.sha256 !== f.sha256) modified.push(f);
    else unchanged++;
  }
  const removed = (prev?.files ?? []).filter((f) => !after.has(f.path));
  return {
    added,
    modified,
    removed,
    unchanged,
    downloadSize: [...added, ...modified].reduce((n, f) => n + f.size, 0),
  };
}

/** Motif glob → RegExp (insensible à la casse, comme le système de fichiers Windows). `**` traverse les dossiers. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export function isProtected(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

export function parseManifest(json: unknown): Manifest {
  const m = json as Manifest;
  if (!m || !Array.isArray(m.files)) throw new Error("Manifeste invalide");
  return {
    files: m.files,
    managedDirs: Array.isArray(m.managedDirs) ? m.managedDirs : [],
    protected: Array.isArray(m.protected) ? m.protected : [],
    migrations: Array.isArray(m.migrations) ? m.migrations : [],
  };
}
