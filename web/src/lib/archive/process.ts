import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { Storage } from "../storage/types";
import { blobKey } from "../storage/types";
import type { ManifestFile } from "../manifest";
import { ArchiveError, commonRoot, extensionOf, normalizeEntryPath } from "./paths";

export interface ArchiveLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
  blockedExtensions: string[];
}

export interface ProcessResult {
  files: ManifestFile[];
  totalSize: number;
  newBlobs: number;
  reusedBlobs: number;
  strippedRoot: string | null;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (err, z) =>
      err || !z ? reject(new ArchiveError(`Archive ZIP invalide : ${err?.message ?? "inconnue"}`)) : resolve(z),
    );
  });
}

function readEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on("entry", (e: yauzl.Entry) => {
      entries.push(e);
      zip.readEntry();
    });
    zip.on("end", () => resolve(entries));
    zip.on("error", (e) => reject(new ArchiveError(`Archive ZIP invalide : ${e.message}`)));
    zip.readEntry();
  });
}

function openStream(zip: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<NodeJS.ReadableStream>((resolve, reject) =>
    zip.openReadStream(entry, (err, s) => (err || !s ? reject(err ?? new Error("flux vide")) : resolve(s))),
  );
}

/**
 * Valide l'archive (chemins, symlinks, extensions, taille, ratio de compression), puis stocke chaque fichier
 * comme blob adressé par son SHA-256 (les blobs déjà présents ne sont pas retéléversés).
 */
export async function processArchive(
  zipPath: string,
  storage: Storage,
  limits: ArchiveLimits,
  opts: { stripRoot?: boolean } = {},
): Promise<ProcessResult> {
  const zip = await openZip(zipPath);
  const tmp = await mkdtemp(path.join(tmpdir(), "fbm-extract-"));
  try {
    const raw = (await readEntries(zip)).filter((e) => !e.fileName.endsWith("/"));
    if (raw.length === 0) throw new ArchiveError("L'archive ne contient aucun fichier");
    if (raw.length > limits.maxFiles) throw new ArchiveError(`Trop de fichiers (${raw.length} > ${limits.maxFiles})`);

    let names = raw.map((e) => normalizeEntryPath(e.fileName));
    let strippedRoot: string | null = null;
    if (opts.stripRoot !== false) {
      const root = commonRoot(names);
      if (root) {
        strippedRoot = root;
        names = names.map((n) => n.slice(root.length));
        names.forEach(normalizeEntryPath);
      }
    }

    const seen = new Set<string>();
    let declaredTotal = 0;
    raw.forEach((e, i) => {
      const name = names[i];
      const key = name.toLowerCase();
      if (seen.has(key)) throw new ArchiveError(`Fichier en double (insensible à la casse) : ${name}`);
      seen.add(key);
      if (e.isEncrypted()) throw new ArchiveError(`Fichier chiffré non supporté : ${name}`);
      const mode = (e.externalFileAttributes >>> 16) & S_IFMT;
      if (mode === S_IFLNK) throw new ArchiveError(`Lien symbolique interdit : ${name}`);
      const ext = extensionOf(name);
      if (ext && limits.blockedExtensions.includes(ext)) throw new ArchiveError(`Extension interdite (${ext}) : ${name}`);
      if (e.uncompressedSize > limits.maxFileBytes) throw new ArchiveError(`Fichier trop volumineux : ${name}`);
      if (e.uncompressedSize > 1024 * 1024 && e.uncompressedSize / Math.max(e.compressedSize, 1) > limits.maxRatio) {
        throw new ArchiveError(`Ratio de compression suspect (zip bomb ?) : ${name}`);
      }
      declaredTotal += e.uncompressedSize;
      if (declaredTotal > limits.maxTotalBytes) throw new ArchiveError("Taille décompressée totale trop grande");
    });

    const files: ManifestFile[] = [];
    let newBlobs = 0;
    let reusedBlobs = 0;
    let actualTotal = 0;
    const done = new Map<string, string>(); // sha -> true (dédoublonnage intra-archive)

    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      const hash = createHash("sha256");
      let size = 0;
      const tmpFile = path.join(tmp, `f${i}`);
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          actualTotal += chunk.length;
          if (size > limits.maxFileBytes || actualTotal > limits.maxTotalBytes) {
            return cb(new ArchiveError(`Taille réelle supérieure aux limites : ${names[i]}`));
          }
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const src = await openStream(zip, entry);
      await pipeline(src, counter, createWriteStream(tmpFile));
      const sha = hash.digest("hex");
      if (!done.has(sha)) {
        const key = blobKey(sha);
        if (await storage.exists(key)) reusedBlobs++;
        else {
          await storage.putFile(key, tmpFile, "application/octet-stream");
          newBlobs++;
        }
        done.set(sha, key);
      } else reusedBlobs++;
      await rm(tmpFile, { force: true });
      files.push({ path: names[i], sha256: sha, size });
    }
    return { files, totalSize: actualTotal, newBlobs, reusedBlobs, strippedRoot };
  } finally {
    zip.close();
    await rm(tmp, { recursive: true, force: true });
  }
}
