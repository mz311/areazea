"use strict";
/* global RegisterCommand, GetConvar, GetConvarInt, GetCurrentResourceName, GetResourcePath, GetResourceState,
          GetPlayerName, IsPlayerAceAllowed, getPlayers, emitNet, on, source */
/**
 * Intégration FiveM : commande « fbm » (console txAdmin et en jeu avec la permission command.fbm),
 * application de la mise à jour préparée au démarrage, vérification périodique des nouvelles versions.
 */
const fs = require("fs");
const path = require("path");
const F = globalThis.FBM;
const RES = GetCurrentResourceName();
const TAG = "^5[fbm]^7 ";

const HELP = [
  "fbm status         version installée / disponible, patch notes et ce qui changera",
  "fbm update         télécharge la dernière version, exécute son SQL, fichiers appliqués au prochain redémarrage",
  "fbm update 1.2.0   prépare une version précise (ex. revenir en arrière)",
  "fbm repair         re-vérifie tous les fichiers (et le SQL manquant) et prépare la réparation",
  "fbm cancel         annule une mise à jour préparée",
  "fbm sql            état du SQL (registre fbm_migrations)",
  "fbm sql baseline   base de données existante : marque le SQL de la version installée comme déjà appliqué",
  "fbm sql run        exécute le SQL manquant de la version installée",
].join("\n");

function log(msg) {
  for (const line of String(msg).split("\n")) console.log(TAG + line);
}

/** Répond dans la console (source 0) ou dans le chat du joueur (et trace l'action dans la console). */
function say(src, msg) {
  if (!src) return log(msg);
  for (const line of String(msg).split("\n")) {
    emitNet("chat:addMessage", src, { color: [166, 107, 255], multiline: true, args: ["Mise à jour", line.replace(/\^\d/g, "")] });
  }
}

function fileConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(GetResourcePath(RES), "config.json"), "utf8"));
  } catch (e) {
    return {};
  }
}

function config() {
  const file = fileConfig();
  const dir = GetConvar("fbm_dir", "") || file.dir || F.guessBaseDir(GetResourcePath(RES)) || process.cwd();
  return {
    api: String(GetConvar("fbm_api", "") || file.api || "").replace(/\/+$/, ""),
    token: GetConvar("fbm_token", ""),
    channel: String(GetConvar("fbm_channel", "") || file.channel || "STABLE").toUpperCase(),
    dir: path.resolve(dir),
    extraProtected: String(GetConvar("fbm_protect", ""))
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    checkMinutes: GetConvarInt("fbm_check_interval", 60),
    /** auto : le SQL des mises à jour est exécuté via oxmysql ; off : affiché seulement (import manuel) */
    sqlMode: String(GetConvar("fbm_sql", "auto")).toLowerCase() === "off" ? "off" : "auto",
  };
}

/** Accès à la base de données du serveur via oxmysql (null si oxmysql n'est pas démarré). */
function database() {
  if (GetResourceState("oxmysql") !== "started") return null;
  return {
    query: (sql, params) =>
      new Promise((resolve, reject) => {
        try {
          // signature oxmysql : (requête, paramètres, callback, ressource appelante, mode promesse → callback(résultat, erreur)).
          // globalThis : « exports » seul pourrait désigner les exports du module plutôt que ceux de FiveM.
          globalThis.exports.oxmysql.query(sql, params || [], (result, err) => (err ? reject(new Error(String(err))) : resolve(result)), RES, true);
        } catch (e) {
          reject(e);
        }
      }),
  };
}

/** Patch notes des versions entre l'installée et la cible (renvoyées par le site). */
function patchNotes(remote, maxLines) {
  const lines = [];
  for (const h of remote.history || []) {
    lines.push(`v${h.version}${h.title ? ` — ${h.title}` : ""}`);
    for (const ch of h.changes || []) lines.push(`  ${ch.type.padEnd(11)} ${ch.text}`);
    for (const f of h.sql || []) lines.push(`  ${"SQL".padEnd(11)} ${f}`);
  }
  if (lines.length > maxLines) return lines.slice(0, maxLines - 1).concat([`  … (patch notes complètes sur le site)`]);
  return lines;
}

/**
 * SQL de la mise à jour : chaque fichier de l'historique pas encore inscrit dans fbm_migrations est exécuté, dans l'ordre.
 * Aucune exécution sur une base existante dont l'historique est inconnu (registre absent) : il faut « fbm sql baseline ».
 */
async function updateSql(src, c, migrations) {
  if (!migrations.length) return { ran: [] };
  if (c.sqlMode === "off") {
    say(src, "SQL non exécuté automatiquement (fbm_sql off) : fichiers dans sql/migrations/, base complète dans sql/install.sql.");
    return { ran: [] };
  }
  const db = database();
  if (!db) {
    throw new F.FbmError("oxmysql n'est pas démarré : impossible d'appliquer le SQL de la mise à jour (démarrez oxmysql, ou « set fbm_sql off » pour l'importer vous-même).", "sql");
  }
  const st = await F.sqlStatus(db, migrations);
  if (st.ledger === null && !st.emptyDb) {
    throw new F.FbmError(
      "Base de données existante sans registre fbm_migrations : impossible de savoir quel SQL a déjà été appliqué.\n" +
        "  Si elle correspond à votre version installée : « fbm sql baseline » puis relancez « fbm update ».\n" +
        "  Si elle est vide : importez sql/install.sql.",
      "sql_baseline",
    );
  }
  if (st.changed.length) say(src, `^3Note : ${st.changed.map((m) => `${m.version}/${m.name}`).join(", ")} ont été modifiés sur le site après leur exécution (non ré-exécutés).^7`);
  if (!st.pending.length) return { ran: [] };
  say(src, `${st.ledger === null ? "Base de données vide : installation complète du SQL. " : ""}SQL à exécuter : ${st.pending.map((m) => `${m.version}/${m.name}`).join(", ")}`);
  await F.runSql(c.dir, db, st.pending, (m, n) => say(src, `  → ${m.version}/${m.name} (${n} instruction(s))`));
  return { ran: st.pending };
}

function errText(e) {
  if (e && e.code === "unauthenticated") return "Jeton refusé : créez-en un nouveau sur le site (Mon compte) et mettez à jour fbm_token.";
  if (e && e.code === "not_in_guild") return `${e.message} (le compte du jeton doit être sur le serveur Discord).`;
  return e && e.message ? e.message : String(e);
}

// ───────────────────────────── démarrage : application de la mise à jour préparée ─────────────────────────────

(function boot() {
  const c = config();
  try {
    if (F.recoverSync(c.dir)) log("^3Une opération interrompue a été annulée : l'installation a été restaurée.^7");
    const r = F.applyPendingSync(c.dir, { extraProtected: c.extraProtected });
    if (!r) return;
    log(
      `^2✔ Mise à jour appliquée : ${r.fromVersion ? `v${r.fromVersion} → ` : ""}v${r.version}^7 ` +
        `(${r.written} fichier(s) écrit(s), ${r.deleted} supprimé(s), ${r.keptProtected} config(s) protégée(s) conservée(s)).`,
    );
    const started = F.resourcesOf(c.dir, r.changedPaths).filter((n) => n !== RES && ["started", "starting"].includes(GetResourceState(n)));
    if (started.length) {
      log(`^3Attention : ${started.join(", ")} étai(en)t déjà démarrée(s) avec l'ancienne version.^7`);
      log("^3Placez « ensure fbm-updater » en PREMIER dans server.cfg, puis redémarrez encore une fois.^7");
    }
    if (c.api && c.token) new F.Api(c.api, c.token).report(r.version, r.kind).catch(() => undefined);
  } catch (e) {
    log(`^1Mise à jour non appliquée : ${errText(e)}^7`);
    if (F.readPending(c.dir)) log("Elle sera retentée au prochain redémarrage (« fbm cancel » pour l'abandonner).");
  }
})();

// ───────────────────────────── commande ─────────────────────────────

let busy = false;

function describePlan(p) {
  return (
    `${p.downloadFiles} fichier(s) à télécharger (${F.formatBytes(p.downloadBytes)}), ${p.deletes.length} à supprimer, ` +
    `${p.keptProtected.length} config(s) protégée(s) conservée(s), ${p.unchanged} inchangé(s)`
  );
}

async function status(src, c) {
  const api = new F.Api(c.api, c.token);
  const installed = F.loadState(c.dir);
  const pending = F.readPending(c.dir);
  const remote = await api.latest(c.channel, undefined, installed ? installed.version : undefined);
  const p = await F.plan(c.dir, remote.manifest, { mode: "update", extraProtected: c.extraProtected });
  let sqlLine = null;
  const migrations = remote.manifest.migrations || [];
  const db = c.sqlMode === "auto" ? database() : null;
  if (migrations.length && db) {
    const st = await F.sqlStatus(db, migrations);
    sqlLine =
      st.ledger === null && !st.emptyDb
        ? "SQL : registre fbm_migrations absent (« fbm sql » pour les détails)"
        : `SQL : ${st.pending.length ? `${st.pending.length} fichier(s) à exécuter (${st.pending.map((m) => m.name).join(", ")})` : "à jour"}`;
  } else if (migrations.length) sqlLine = c.sqlMode === "off" ? "SQL : géré manuellement (fbm_sql off)" : "SQL : oxmysql non démarré";
  const lines = [
    `Base : ${c.dir}`,
    `Installée : ${installed ? `v${installed.version} (${installed.channel})` : "aucune (installation existante non suivie)"}`,
    `Disponible : v${remote.version}${remote.title ? ` — ${remote.title}` : ""} (${c.channel})`,
  ];
  if (pending) lines.push(`^3Préparée : v${pending.version} — sera appliquée au prochain redémarrage.^7`);
  if (sqlLine) lines.push(sqlLine);
  if (!p.writes.length && !p.deletes.length && installed && installed.version === remote.version) lines.push("^2✔ Fichiers à jour.^7");
  else {
    lines.push(`Changements : ${describePlan(p)}`);
    const notes = patchNotes(remote, src ? 10 : 30);
    if (notes.length) lines.push("Patch notes :", ...notes);
    lines.push("→ tapez « fbm update » pour préparer la mise à jour.");
  }
  say(src, lines.join("\n"));
}

async function prepare(src, c, mode, version) {
  const api = new F.Api(c.api, c.token);
  const installed = F.loadState(c.dir);
  // la réparation vise la version installée ; la mise à jour, la dernière version (ou celle demandée)
  const target = mode === "repair" ? (installed ? installed.version : undefined) : version;
  say(src, mode === "repair" ? "Vérification de tous les fichiers (SHA-256)…" : "Recherche de la mise à jour…");
  const remote = await api.latest(c.channel, target, installed ? installed.version : undefined);
  const p = await F.plan(c.dir, remote.manifest, { mode, extraProtected: c.extraProtected });
  const filesUpToDate = !p.writes.length && !p.deletes.length && installed && installed.version === remote.version;
  const kind = mode === "repair" ? "REPAIR" : installed ? "UPDATE" : "INSTALL";

  if (!filesUpToDate) {
    say(src, `Préparation de v${remote.version} : ${describePlan(p)}.`);
    let last = Date.now();
    await F.prepare({
      dir: c.dir,
      api,
      remote,
      plan: p,
      kind,
      fromVersion: installed ? installed.version : null,
      onProgress: (s) => {
        const now = Date.now();
        if (now - last < (src ? 10000 : 3000)) return;
        last = now;
        const pct = s.bytesTotal ? Math.floor((s.bytesDone / s.bytesTotal) * 100) : 100;
        say(src, `… ${pct} % — ${s.filesDone}/${s.filesTotal} fichier(s) — ${F.formatBytes(s.bytesDone)} / ${F.formatBytes(s.bytesTotal)}`);
      },
    });
  } else F.cancelPending(c.dir);

  // SQL : exécuté maintenant (le serveur tourne, oxmysql est disponible) ; les fichiers suivent au redémarrage.
  // En cas d'échec, la mise à jour des fichiers est annulée : le nouveau code ne démarre pas sans son SQL.
  let sql;
  try {
    sql = await updateSql(src, c, remote.manifest.migrations || []);
  } catch (e) {
    if (!filesUpToDate) F.cancelPending(c.dir);
    if (!filesUpToDate) e.message += "\nMise à jour des fichiers annulée : corrigez le problème puis relancez « fbm update ».";
    throw e;
  }

  const lines = [];
  if (sql.ran.length) lines.push(`^2✔ SQL exécuté : ${sql.ran.length} fichier(s).^7`);
  if (filesUpToDate) {
    lines.push(sql.ran.length ? `Fichiers déjà à jour (v${remote.version}).` : `^2✔ Rien à faire : v${remote.version} est installée et intacte.^7`);
  } else {
    lines.push(`^2✔ v${remote.version} téléchargée et vérifiée.^7 Redémarrez le serveur pour l'appliquer (txAdmin → Restart).`, "Annuler : « fbm cancel ».");
    if (remote.relation === "downgrade") lines.push("^3Retour à une version antérieure : le SQL des versions plus récentes n'est pas annulé.^7");
    const notes = patchNotes(remote, src ? 10 : 30);
    if (notes.length) lines.push("Patch notes :", ...notes);
  }
  say(src, lines.join("\n"));
  if (src) log(`${GetPlayerName(src)} a lancé « fbm ${mode} » : v${remote.version} (${kind}${sql.ran.length ? `, ${sql.ran.length} SQL` : ""}).`);
}

async function sqlCommand(src, c, action) {
  const installed = F.loadState(c.dir);
  if (!installed) return say(src, "Aucune version installée par fbm sur ce serveur : lancez d'abord « fbm update ».");
  const db = database();
  if (!db) return say(src, "oxmysql n'est pas démarré : impossible d'accéder à la base de données.");
  const remote = await new F.Api(c.api, c.token).latest(c.channel, installed.version);
  const migrations = remote.manifest.migrations || [];
  if (action === "baseline") {
    const n = await F.baselineSql(db, migrations);
    log(`fbm sql baseline : ${n} fichier(s) SQL de v${installed.version} marqué(s) comme appliqué(s)${src ? ` par ${GetPlayerName(src)}` : ""}.`);
    return say(src, `^2✔ ${n} fichier(s) SQL de v${installed.version} marqué(s) comme déjà appliqué(s).^7 Les prochaines mises à jour n'exécuteront que leur propre SQL.`);
  }
  const st = await F.sqlStatus(db, migrations);
  if (action === "run") {
    if (st.ledger === null && !st.emptyDb) return say(src, "Registre absent sur une base existante : utilisez « fbm sql baseline » (ou importez sql/install.sql sur une base vide).");
    if (!st.pending.length) return say(src, "^2✔ Aucun SQL en attente.^7");
    await F.runSql(c.dir, db, st.pending, (m, n) => say(src, `  → ${m.version}/${m.name} (${n} instruction(s))`));
    return say(src, `^2✔ SQL exécuté : ${st.pending.length} fichier(s).^7`);
  }
  const lines = [`Version installée : v${installed.version} — ${migrations.length} fichier(s) SQL dans son historique.`];
  if (st.ledger === null) {
    lines.push(st.emptyDb ? "Base de données vide : importez sql/install.sql (ou « fbm sql run »)." : "Registre fbm_migrations absent : « fbm sql baseline » si la base correspond à cette version.");
  } else {
    lines.push(`Appliqués : ${st.applied.length}  ·  En attente : ${st.pending.length}`);
    for (const m of st.pending) lines.push(`  en attente : ${m.version}/${m.name}`);
    for (const m of st.changed) lines.push(`  modifié depuis son exécution : ${m.version}/${m.name}`);
  }
  say(src, lines.join("\n"));
}

async function handle(src, args) {
  const sub = String(args[0] || "status").toLowerCase();
  if (["help", "aide"].includes(sub)) return say(src, HELP);
  const c = config();
  if (["cancel", "annuler"].includes(sub)) {
    const p = F.readPending(c.dir);
    F.cancelPending(c.dir);
    return say(src, p ? `Mise à jour v${p.version} annulée.` : "Aucune mise à jour préparée.");
  }
  if (!["status", "etat", "état", "update", "maj", "repair", "reparer", "réparer", "sql"].includes(sub)) return say(src, `Commande inconnue.\n${HELP}`);
  if (!c.api || !c.token) {
    return say(src, "Configuration manquante. Dans server.cfg :\n  set fbm_api \"https://votre-site\"\n  set fbm_token \"fvl_…\"  (jeton créé sur le site, page Mon compte)");
  }
  if (busy) return say(src, "Une opération est déjà en cours, patientez.");
  busy = true;
  try {
    if (F.recoverSync(c.dir)) say(src, "Une opération interrompue a été annulée : installation restaurée.");
    if (["status", "etat", "état"].includes(sub)) await status(src, c);
    else if (sub === "sql") await sqlCommand(src, c, String(args[1] || "status").toLowerCase());
    else if (["repair", "reparer", "réparer"].includes(sub)) await prepare(src, c, "repair");
    else await prepare(src, c, "update", args[1]);
  } catch (e) {
    say(src, `^1Échec : ${errText(e)}^7`);
  } finally {
    busy = false;
  }
}

// restricted = true : en jeu, seuls les joueurs ayant la permission « command.fbm » peuvent l'utiliser ;
// la console serveur / txAdmin y a toujours accès.
RegisterCommand("fbm", (src, args) => handle(Number(src) || 0, args || []), true);

// ───────────────────────────── vérification périodique ─────────────────────────────

let available = null;
let announced = null;

function notifyAdmins(msg) {
  for (const p of getPlayers()) if (IsPlayerAceAllowed(p, "command.fbm")) say(Number(p), msg);
}

async function check() {
  const c = config();
  if (!c.api || !c.token || busy) return;
  try {
    const remote = await new F.Api(c.api, c.token).latest(c.channel);
    const installed = F.loadState(c.dir);
    const pending = F.readPending(c.dir);
    available = !installed || installed.version !== remote.version ? remote.version : null;
    if (available && announced !== available && !(pending && pending.version === available)) {
      announced = available;
      log(`^3Nouvelle version disponible : v${available}^7 — tapez « fbm update ».`);
      notifyAdmins(`Nouvelle version de la base disponible : v${available}. Tapez /fbm update.`);
    }
  } catch (e) {
    if (e && e.status === 401) log("^1fbm_token refusé (révoqué ?) : créez un nouveau jeton sur le site.^7");
  }
}

setTimeout(check, 15000);
const every = config().checkMinutes;
if (every > 0) setInterval(check, every * 60000);

on("playerJoining", () => {
  const src = Number(source);
  if (!available) return;
  setTimeout(() => {
    if (IsPlayerAceAllowed(src, "command.fbm")) say(src, `Nouvelle version de la base disponible : v${available}. Tapez /fbm update.`);
  }, 10000);
});
