export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const MAX_PATH = 240;

/**
 * Valide et normalise un chemin d'entrée d'archive. Les chemins doivent être relatifs,
 * en notation POSIX, sans `..`, sans lecteur Windows, sans noms réservés Windows.
 * Les mêmes règles sont appliquées côté launcher (défense en profondeur).
 */
export function normalizeEntryPath(raw: string): string {
  if (!raw || raw.includes("\u0000")) throw new ArchiveError(`Chemin invalide : "${printable(raw)}"`);
  if (raw.includes("\\")) throw new ArchiveError(`Antislash interdit dans le chemin : "${printable(raw)}"`);
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new ArchiveError(`Chemin absolu interdit : "${printable(raw)}"`);
  const p = raw.normalize("NFC");
  if (p.length > MAX_PATH) throw new ArchiveError(`Chemin trop long : "${printable(p.slice(0, 60))}…"`);
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") throw new ArchiveError(`Segment interdit dans "${printable(p)}"`);
    if (BAD_CHARS.test(seg)) throw new ArchiveError(`Caractère interdit dans "${printable(p)}"`);
    if (/[. ]$/.test(seg)) throw new ArchiveError(`Segment finissant par un point ou un espace : "${printable(p)}"`);
    if (RESERVED.test(seg)) throw new ArchiveError(`Nom réservé Windows : "${printable(p)}"`);
    if (seg.length > 200) throw new ArchiveError(`Nom trop long dans "${printable(p.slice(0, 60))}…"`);
  }
  if (segments[0].toLowerCase() === ".fbm") throw new ArchiveError(`Le dossier .fbm est réservé au launcher`);
  return p;
}

const printable = (s: string) => s.replace(/[\u0000-\u001f]/g, "?").slice(0, 120);

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

/** Retourne le préfixe commun unique (ex. "ma-base/") si TOUTES les entrées sont dans un seul dossier racine. */
export function commonRoot(paths: string[]): string | null {
  if (!paths.length) return null;
  const first = paths[0].split("/")[0];
  if (!paths.every((p) => p.includes("/") && p.split("/")[0] === first)) return null;
  return first + "/";
}
