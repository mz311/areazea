"use strict";
/**
 * Moteur de mise à jour de la base (sans dépendance FiveM : testable avec Node seul).
 * Même format que le launcher et fbm-cli (.fbm/state.json, .fbm/txn.json) : on peut passer de l'un à l'autre.
 *
 *  1. plan()             compare le dossier au manifeste (SHA-256)
 *  2. prepare()          télécharge et vérifie les fichiers dans .fbm/pending/ — le serveur continue de tourner
 *  3. applyPendingSync() au démarrage suivant, avant les autres ressources : sauvegarde, écriture, état ;
 *                        toute erreur restaure l'installation à l'identique (journal .fbm/txn.json)
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const MAX_PATH = 240;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;

class FbmError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code || "error";
    this.status = status;
  }
}

// ───────────────────────────── chemins & motifs ─────────────────────────────

function validateRel(rel) {
  const bad = (why) => {
    throw new FbmError(`Chemin dangereux refusé : ${JSON.stringify(rel)} (${why})`, "unsafe_path");
  };
  if (typeof rel !== "string" || !rel || rel.length > MAX_PATH) bad("longueur");
  if (rel.includes("\\") || rel.includes("\0") || rel.startsWith("/")) bad("séparateur ou chemin absolu");
  if (/^[a-zA-Z]:/.test(rel)) bad("lecteur Windows");
  rel.split("/").forEach((seg, i) => {
    if (!seg || seg === "." || seg === "..") bad("segment interdit");
    if (BAD_CHARS.test(seg)) bad("caractère interdit");
    if (/[. ]$/.test(seg)) bad("point ou espace final");
    if (RESERVED.test(seg)) bad("nom réservé Windows");
    if (i === 0 && seg.toLowerCase() === ".fbm") bad("dossier réservé");
  });
}

function safeJoin(root, rel) {
  validateRel(rel);
  return path.join(root, ...rel.split("/"));
}

/** Refuse d'écrire à travers un lien symbolique / une jonction situé sous la racine. */
function assertNoSymlinkParents(root, target) {
  let dir = path.dirname(target);
  while (dir !== root && dir.startsWith(root + path.sep)) {
    let st = null;
    try {
      st = fs.lstatSync(dir);
    } catch (e) {
      st = null;
    }
    if (st && st.isSymbolicLink()) throw new FbmError(`${dir} est un lien symbolique`, "unsafe_path");
    dir = path.dirname(dir);
  }
}

/** Motif glob → RegExp (insensible à la casse). Identique au serveur et au launcher. */
function globToRegExp(glob) {
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

function matcher(patterns) {
  const res = patterns.map(globToRegExp);
  return (p) => res.some((r) => r.test(p));
}

function isManaged(p, managedDirs) {
  const i = p.indexOf("/");
  if (i <= 0) return false;
  const top = p.slice(0, i).toLowerCase();
  return managedDirs.some((d) => d.toLowerCase() === top);
}

// ───────────────────────────── manifeste & état ─────────────────────────────

function manifestDigest(m) {
  const canonical = JSON.stringify({
    files: m.files.map((f) => [f.path, f.sha256, f.size]),
    managedDirs: m.managedDirs,
    protected: m.protected,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function validateManifest(m) {
  if (!m || !Array.isArray(m.files)) throw new FbmError("Manifeste invalide", "integrity");
  m.managedDirs = Array.isArray(m.managedDirs) ? m.managedDirs : [];
  m.protected = Array.isArray(m.protected) ? m.protected : [];
  const seen = new Set();
  for (const f of m.files) {
    validateRel(f.path);
    if (!/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isInteger(f.size) || f.size < 0) {
      throw new FbmError(`Entrée invalide dans le manifeste : ${f.path}`, "integrity");
    }
    const k = f.path.toLowerCase();
    if (seen.has(k)) throw new FbmError(`Chemin en double dans le manifeste : ${f.path}`, "integrity");
    seen.add(k);
  }
  return m;
}

const fbmDir = (dir) => path.join(dir, ".fbm");
const statePath = (dir) => path.join(fbmDir(dir), "state.json");
const journalPath = (dir) => path.join(fbmDir(dir), "txn.json");
const pendingDir = (dir) => path.join(fbmDir(dir), "pending");
const pendingPath = (dir) => path.join(fbmDir(dir), "pending.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null; // absent ou illisible
  }
}

function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** État d'installation (même format que le launcher Rust : version, channel, installed_at, files). */
function loadState(dir) {
  const s = readJson(statePath(dir));
  return s && typeof s.version === "string" && s.files ? s : null;
}

function readPending(dir) {
  const p = readJson(pendingPath(dir));
  return p && p.version && p.manifest ? p : null;
}

function cancelPending(dir) {
  fs.rmSync(pendingDir(dir), { recursive: true, force: true });
  fs.rmSync(pendingPath(dir), { force: true });
}

// ───────────────────────────── hachage ─────────────────────────────

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    let size = 0;
    fs.createReadStream(file)
      .on("data", (c) => {
        size += c.length;
        h.update(c);
      })
      .on("error", reject)
      .on("end", () => resolve({ sha: h.digest("hex"), size }));
  });
}

function hashFileSync(file) {
  const fd = fs.openSync(file, "r");
  try {
    const h = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      size += n;
    }
    return { sha: h.digest("hex"), size };
  } finally {
    fs.closeSync(fd);
  }
}

// ───────────────────────────── HTTP (sans fetch : compatible Node 16) ─────────────────────────────

function httpRequest(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new FbmError(`URL invalide : ${url}`, "config"));
    }
    const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!lib) return reject(new FbmError(`Protocole non supporté : ${u.protocol}`, "config"));
    const req = lib.request(u, { method: opts.method || "GET", headers: opts.headers || {} }, resolve);
    req.setTimeout(opts.timeoutMs || 60000, () => req.destroy(new FbmError("Délai réseau dépassé", "network")));
    req.on("error", (e) => reject(e instanceof FbmError ? e : new FbmError(`Erreur réseau : ${e.message}`, "network")));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

class Api {
  constructor(base, token) {
    this.base = String(base || "").replace(/\/+$/, "");
    this.token = token;
  }

  async call(method, p, body) {
    const headers = { Authorization: `Bearer ${this.token}`, "User-Agent": "fbm-updater/1.0" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await httpRequest(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = await readBody(res);
    let json = null;
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch (e) {
      json = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new FbmError((json && json.error) || `Erreur HTTP ${res.statusCode}`, (json && json.code) || "http", res.statusCode);
    }
    return json;
  }

  async me() {
    return (await this.call("GET", "/api/launcher/me")).user;
  }

  async latest(channel, version) {
    const q = new URLSearchParams({ channel: channel || "STABLE" });
    if (version) q.set("version", version);
    const v = await this.call("GET", `/api/launcher/latest?${q}`);
    validateManifest(v.manifest);
    if (manifestDigest(v.manifest) !== v.manifestSha256) throw new FbmError("Manifeste altéré (empreinte incorrecte)", "integrity");
    return v;
  }

  async blobUrls(version, hashes) {
    return (await this.call("POST", "/api/launcher/blobs", { version, hashes })).urls;
  }

  report(version, kind) {
    return this.call("POST", "/api/launcher/report", { version, kind });
  }
}

// ───────────────────────────── plan ─────────────────────────────

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * mode "update" : se fie à l'état local pour les fichiers déjà connus et inchangés (rapide).
 * mode "repair" : re-hache tout et prévoit de réécrire ce qui est absent ou corrompu.
 */
async function plan(dir, manifest, opts) {
  opts = opts || {};
  const mode = opts.mode || "update";
  validateManifest(manifest);
  const old = loadState(dir);
  const isProt = matcher(manifest.protected.concat(opts.extraProtected || []));
  const writes = [];
  const kept = [];
  let unchanged = 0;

  await pool(manifest.files, 8, async (f) => {
    const target = safeJoin(dir, f.path);
    assertNoSymlinkParents(dir, target);
    let st = null;
    try {
      st = await fsp.lstat(target);
    } catch (e) {
      st = null;
    }
    if (st && st.isSymbolicLink()) throw new FbmError(`${f.path} est un lien symbolique`, "unsafe_path");
    const exists = !!st && st.isFile();
    if (isProt(f.path) && exists) return void kept.push(f.path);
    if (!exists) return void writes.push(f);
    const rec = old && old.files[f.path];
    const trusted = mode === "update" && rec && rec.sha256 === f.sha256 && rec.size === f.size && st.size === f.size;
    if (trusted || (await hashFile(target)).sha === f.sha256) unchanged++;
    else writes.push(f);
  });

  // suppressions : uniquement les fichiers installés précédemment (état), dans un dossier géré, non protégés
  const deletes = [];
  if (old) {
    const keep = new Set(manifest.files.map((f) => f.path));
    for (const p of Object.keys(old.files)) {
      if (keep.has(p) || isProt(p) || !isManaged(p, manifest.managedDirs)) continue;
      let target;
      try {
        target = safeJoin(dir, p);
        assertNoSymlinkParents(dir, target);
      } catch (e) {
        continue;
      }
      try {
        if (fs.lstatSync(target).isFile()) deletes.push(p);
      } catch (e) {
        /* déjà absent */
      }
    }
  }

  writes.sort((a, b) => (a.path < b.path ? -1 : 1));
  deletes.sort();
  kept.sort();
  const unique = new Map(writes.map((f) => [f.sha256, f.size]));
  let downloadBytes = 0;
  unique.forEach((s) => (downloadBytes += s));
  return { writes, deletes, keptProtected: kept, unchanged, downloadFiles: unique.size, downloadBytes };
}

// ───────────────────────────── téléchargement (préparation) ─────────────────────────────

function downloadOnce(url, dest, sha, size, progress) {
  return httpRequest(url, { timeoutMs: 60000 }).then(
    (res) =>
      new Promise((resolve, reject) => {
        const s = res.statusCode;
        if (s === 401 || s === 403) {
          res.resume();
          return reject(new FbmError("lien expiré", "expired"));
        }
        if (s < 200 || s >= 300) {
          res.resume();
          const e = new FbmError(`le serveur de fichiers a répondu ${s}`, s >= 500 || s === 429 ? "retry" : "fatal");
          return reject(e);
        }
        const part = `${dest}.part`;
        const out = fs.createWriteStream(part);
        const h = crypto.createHash("sha256");
        let got = 0;
        let failed = false;
        const fail = (e) => {
          if (failed) return;
          failed = true;
          progress(-got);
          res.destroy();
          out.destroy();
          fs.rmSync(part, { force: true });
          reject(e);
        };
        res.on("data", (c) => {
          got += c.length;
          if (got > size) return fail(new FbmError("fichier plus grand que prévu", "retry"));
          h.update(c);
          progress(c.length);
        });
        res.on("error", (e) => fail(new FbmError(`téléchargement interrompu : ${e.message}`, "retry")));
        out.on("error", (e) => fail(new FbmError(`écriture impossible : ${e.message}`, "fatal")));
        res.pipe(out);
        out.on("finish", () => {
          if (failed) return;
          if (got !== size || h.digest("hex") !== sha) return fail(new FbmError(`SHA-256 incorrect pour le blob ${sha.slice(0, 12)}…`, "retry"));
          fs.renameSync(part, dest);
          resolve();
        });
      }),
  );
}

async function downloadBlob(api, version, url, dest, sha, size, progress, retries) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await downloadOnce(url, dest, sha, size, progress);
    } catch (e) {
      last = e;
      if (e.code === "fatal") throw e;
      if (e.code === "expired") {
        const urls = await api.blobUrls(version, [sha]);
        if (!urls[sha]) throw new FbmError("lien de téléchargement non fourni", "fatal");
        url = urls[sha];
      } else if (e.code === "retry" || e.code === "network") {
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, Math.min(attempt, 4))));
      } else throw e;
    }
  }
  if (last && last.code === "retry" && /SHA-256/.test(last.message)) last.code = "integrity";
  throw last || new FbmError("échec du téléchargement");
}

/**
 * Télécharge et vérifie tout ce que le plan demande dans .fbm/pending/, puis écrit pending.json.
 * Rien n'est modifié dans la base : l'application a lieu au prochain démarrage (applyPendingSync).
 */
async function prepare(opts) {
  const { dir, api, remote, kind } = opts;
  const p = opts.plan;
  const onProgress = opts.onProgress || (() => {});
  const blobsDir = path.join(pendingDir(dir), "blobs");
  cancelPending(dir);
  fs.mkdirSync(blobsDir, { recursive: true });

  const unique = Array.from(new Map(p.writes.map((f) => [f.sha256, f.size])).entries());
  const st = { bytesDone: 0, bytesTotal: p.downloadBytes, filesDone: 0, filesTotal: unique.length };
  const progress = (n) => {
    st.bytesDone += n;
    onProgress(Object.assign({}, st));
  };
  try {
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const urls = await api.blobUrls(remote.version, chunk.map((c) => c[0]));
      await pool(chunk, opts.concurrency || 4, async ([sha, size]) => {
        if (!urls[sha]) throw new FbmError(`aucun lien pour le blob ${sha.slice(0, 12)}…`, "fatal");
        await downloadBlob(api, remote.version, urls[sha], path.join(blobsDir, sha), sha, size, progress, opts.retries === undefined ? 3 : opts.retries);
        st.filesDone++;
        onProgress(Object.assign({}, st));
      });
    }
    const pending = {
      version: remote.version,
      channel: remote.channel,
      kind,
      fromVersion: opts.fromVersion || null,
      preparedAt: new Date().toISOString(),
      writes: p.writes,
      deletes: p.deletes,
      manifest: remote.manifest,
    };
    writeJsonAtomicSync(pendingPath(dir), pending);
    return pending;
  } catch (e) {
    cancelPending(dir);
    throw e;
  }
}

// ───────────────────────────── application (synchrone, au démarrage) ─────────────────────────────

function existsFile(p) {
  try {
    return fs.lstatSync(p).isFile();
  } catch (e) {
    return false;
  }
}

function backupPath(dir, id, rel) {
  return path.join(fbmDir(dir), "backup", id, ...rel.split("/"));
}

/** Restauration « au mieux » : une opération qui échoue n'empêche jamais de restaurer les suivantes. */
function rollbackSync(dir, journal) {
  for (const op of journal.ops.slice().reverse()) {
    let target;
    try {
      target = safeJoin(dir, op.path);
    } catch (e) {
      continue;
    }
    if (op.write) {
      try {
        fs.rmSync(target, { force: true });
      } catch (e) {
        /* ex. ENOTDIR : le fichier n'a jamais pu être créé */
      }
    }
    if (op.had_original) {
      const saved = backupPath(dir, journal.id, op.path);
      if (!existsFile(saved)) continue;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.rmSync(target, { force: true });
        fs.renameSync(saved, target);
      } catch (e) {
        console.log(`[fbm] restauration impossible de ${op.path} : ${e.message} (copie conservée dans .fbm/backup/${journal.id})`);
      }
    }
  }
}

function cleanupTxn(dir, id) {
  fs.rmSync(path.join(fbmDir(dir), "staging", id), { recursive: true, force: true });
  fs.rmSync(path.join(fbmDir(dir), "backup", id), { recursive: true, force: true });
  fs.rmSync(journalPath(dir), { force: true });
  for (const d of ["staging", "backup"]) {
    try {
      fs.rmdirSync(path.join(fbmDir(dir), d));
    } catch (e) {
      /* non vide ou absent */
    }
  }
}

/** Annule une opération interrompue (crash, coupure) — compatible avec le journal du launcher. */
function recoverSync(dir) {
  const j = readJson(journalPath(dir));
  if (!j || typeof j.id !== "string" || !Array.isArray(j.ops)) {
    fs.rmSync(journalPath(dir), { force: true });
    return false;
  }
  if (j.committing) rollbackSync(dir, j);
  cleanupTxn(dir, j.id);
  return !!j.committing;
}

function ioError(e, what) {
  if (e instanceof FbmError) return e;
  const locked = ["EBUSY", "EPERM", "EACCES"].includes(e.code);
  return new FbmError(
    `${what} : ${e.message}${locked ? " — un fichier est probablement utilisé (antivirus, éditeur, autre programme)." : ""}`,
    "io",
  );
}

function removeEmptyParents(dir, rels) {
  for (const rel of rels) {
    let d = path.dirname(safeJoin(dir, rel));
    // jamais la racine ni un dossier de premier niveau (dossier géré lui-même)
    while (d !== dir && path.dirname(d) !== dir) {
      try {
        fs.rmdirSync(d);
      } catch (e) {
        break;
      }
      d = path.dirname(d);
    }
  }
}

/**
 * Applique la mise à jour préparée. Synchrone : appelé pendant le démarrage de la ressource, il se termine
 * avant que les ressources suivantes de server.cfg ne démarrent.
 * Retourne null s'il n'y a rien à appliquer.
 */
function applyPendingSync(dir, opts) {
  opts = opts || {};
  const p = readPending(dir);
  if (!p) return null;
  const manifest = validateManifest(p.manifest);
  const isProt = matcher(manifest.protected.concat(opts.extraProtected || []));
  const pend = pendingDir(dir);

  // re-vérifications : l'utilisateur a pu créer une config protégée depuis la préparation
  const kept = new Set(manifest.files.filter((f) => isProt(f.path) && existsFile(safeJoin(dir, f.path))).map((f) => f.path));
  const writes = p.writes.filter((w) => !kept.has(w.path));
  const deletes = p.deletes.filter((d) => !isProt(d) && existsFile(safeJoin(dir, d)));

  // les fichiers préparés sont-ils intacts ?
  const blobs = new Map(writes.map((w) => [w.sha256, w.size]));
  blobs.forEach((size, sha) => {
    let h = null;
    try {
      h = hashFileSync(path.join(pend, "blobs", sha));
    } catch (e) {
      h = null;
    }
    if (!h || h.sha !== sha || h.size !== size) {
      cancelPending(dir);
      throw new FbmError("Les fichiers préparés sont incomplets ou corrompus : relancez « fbm update ».", "integrity");
    }
  });

  const ops = writes
    .map((w) => ({ path: w.path, write: true, had_original: existsFile(safeJoin(dir, w.path)) }))
    .concat(deletes.map((d) => ({ path: d, write: false, had_original: true })));
  for (const op of ops) assertNoSymlinkParents(dir, safeJoin(dir, op.path));
  const id = `${Date.now().toString(16)}-${process.pid.toString(16)}`;
  const journal = { id, committing: true, ops };
  writeJsonAtomicSync(journalPath(dir), journal);

  try {
    for (const op of ops) {
      if (!op.had_original) continue;
      const saved = backupPath(dir, id, op.path);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.renameSync(safeJoin(dir, op.path), saved);
    }
    for (const w of writes) {
      const target = safeJoin(dir, w.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // copie (et non déplacement) : les fichiers préparés restent intacts si une restauration est nécessaire
      fs.copyFileSync(path.join(pend, "blobs", w.sha256), target);
    }
    removeEmptyParents(dir, deletes);
    const files = {};
    for (const f of manifest.files) if (!kept.has(f.path)) files[f.path] = { sha256: f.sha256, size: f.size };
    writeJsonAtomicSync(statePath(dir), { version: p.version, channel: p.channel, installed_at: Math.floor(Date.now() / 1000), files });
  } catch (e) {
    rollbackSync(dir, journal);
    cleanupTxn(dir, id);
    throw ioError(e, "Mise à jour annulée, installation restaurée");
  }
  cleanupTxn(dir, id);
  cancelPending(dir);
  return {
    version: p.version,
    fromVersion: p.fromVersion,
    kind: p.kind,
    written: writes.length,
    deleted: deletes.length,
    keptProtected: kept.size,
    changedPaths: writes.map((w) => w.path).concat(deletes),
  };
}

// ───────────────────────────── utilitaires ─────────────────────────────

/** Dossier de la base : parent du dossier « resources » qui contient la ressource. */
function guessBaseDir(resourcePath) {
  let d = path.resolve(resourcePath);
  while (path.dirname(d) !== d) {
    if (path.basename(d).toLowerCase() === "resources") return path.dirname(d);
    d = path.dirname(d);
  }
  return null;
}

/** Nom des ressources FiveM (dossier contenant fxmanifest.lua) touchées par une liste de fichiers. */
function resourcesOf(dir, rels) {
  const names = new Set();
  for (const rel of rels) {
    let d = path.dirname(safeJoin(dir, rel));
    while (d !== dir && d.startsWith(dir)) {
      if (existsFile(path.join(d, "fxmanifest.lua")) || existsFile(path.join(d, "__resource.lua"))) {
        names.add(path.basename(d));
        break;
      }
      d = path.dirname(d);
    }
  }
  return Array.from(names).sort();
}

function formatBytes(n) {
  if (!n || n <= 0) return "0 o";
  const u = ["o", "Ko", "Mo", "Go", "To"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

const FBM = {
  FbmError,
  Api,
  validateRel,
  safeJoin,
  globToRegExp,
  matcher,
  isManaged,
  manifestDigest,
  validateManifest,
  loadState,
  readPending,
  cancelPending,
  hashFile,
  hashFileSync,
  plan,
  prepare,
  recoverSync,
  applyPendingSync,
  guessBaseDir,
  resourcesOf,
  formatBytes,
  paths: { fbmDir, statePath, journalPath, pendingDir, pendingPath },
};

globalThis.FBM = FBM;
if (typeof module === "object" && module && module.exports) module.exports = FBM;
