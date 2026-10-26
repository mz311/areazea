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
  "fbm status         version installée / disponible et ce qui changera",
  "fbm update         télécharge et vérifie la dernière version (appliquée au prochain redémarrage)",
  "fbm update 1.2.0   prépare une version précise (ex. revenir en arrière)",
  "fbm repair         re-vérifie tous les fichiers et prépare la réparation de ceux qui sont abîmés",
  "fbm cancel         annule une mise à jour préparée",
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
  };
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
  const remote = await api.latest(c.channel);
  const p = await F.plan(c.dir, remote.manifest, { mode: "update", extraProtected: c.extraProtected });
  const lines = [
    `Base : ${c.dir}`,
    `Installée : ${installed ? `v${installed.version} (${installed.channel})` : "aucune (installation existante non suivie)"}`,
    `Disponible : v${remote.version}${remote.title ? ` — ${remote.title}` : ""} (${c.channel})`,
  ];
  if (pending) lines.push(`^3Préparée : v${pending.version} — sera appliquée au prochain redémarrage.^7`);
  if (!p.writes.length && !p.deletes.length && installed && installed.version === remote.version) lines.push("^2✔ À jour.^7");
  else lines.push(`Changements : ${describePlan(p)}`, "→ tapez « fbm update » pour préparer la mise à jour.");
  say(src, lines.join("\n"));
}

async function prepare(src, c, mode, version) {
  const api = new F.Api(c.api, c.token);
  const installed = F.loadState(c.dir);
  // la réparation vise la version installée ; la mise à jour, la dernière version (ou celle demandée)
  const target = mode === "repair" ? (installed ? installed.version : undefined) : version;
  say(src, mode === "repair" ? "Vérification de tous les fichiers (SHA-256)…" : "Recherche de la mise à jour…");
  const remote = await api.latest(c.channel, target);
  const p = await F.plan(c.dir, remote.manifest, { mode, extraProtected: c.extraProtected });
  if (!p.writes.length && !p.deletes.length && installed && installed.version === remote.version) {
    F.cancelPending(c.dir);
    return say(src, `^2✔ Rien à faire : v${remote.version} est installée et intacte.^7`);
  }
  const kind = mode === "repair" ? "REPAIR" : installed ? "UPDATE" : "INSTALL";
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
  const changes = (remote.changes || []).slice(0, 5).map((ch) => `  ${ch.type}  ${ch.text}`);
  say(
    src,
    [
      `^2✔ v${remote.version} téléchargée et vérifiée.^7 Redémarrez le serveur pour l'appliquer (txAdmin → Restart).`,
      "Annuler : « fbm cancel ».",
    ]
      .concat(changes.length ? ["Nouveautés :"].concat(changes) : [])
      .join("\n"),
  );
  if (src) log(`${GetPlayerName(src)} a préparé la mise à jour v${remote.version} (${kind}).`);
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
  if (!["status", "etat", "état", "update", "maj", "repair", "reparer", "réparer"].includes(sub)) return say(src, `Commande inconnue.\n${HELP}`);
  if (!c.api || !c.token) {
    return say(src, "Configuration manquante. Dans server.cfg :\n  set fbm_api \"https://votre-site\"\n  set fbm_token \"fvl_…\"  (jeton créé sur le site, page Mon compte)");
  }
  if (busy) return say(src, "Une opération est déjà en cours, patientez.");
  busy = true;
  try {
    if (F.recoverSync(c.dir)) say(src, "Une opération interrompue a été annulée : installation restaurée.");
    if (["status", "etat", "état"].includes(sub)) await status(src, c);
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
