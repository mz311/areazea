"use strict";
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const ROLE = { MEMBER: "Membre", VIP: "VIP", DEVELOPER: "Développeur", ADMIN: "Admin" };
const PHASE = { checking: "Vérification des fichiers…", downloading: "Téléchargement", applying: "Installation des fichiers…", verifying: "Vérification SHA-256…", rolling_back: "Restauration de l'installation…", done: "Terminé" };

let st = null; // état local
let update = null; // dernier résultat de check_updates
let busy = false;
let timer = null;

const fmtBytes = (n) => {
  if (!n) return "0 o";
  const u = ["o", "Ko", "Mo", "Go", "To"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};
const fmtEta = (s) => (s == null ? "" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
const text = (id, t) => ($(id).textContent = t);

function setBanner(msg, warn) {
  show("banner", !!msg);
  $("banner").textContent = msg || "";
  $("banner").classList.toggle("warn", !!warn);
}

function setResult(msg, ok) {
  show("result", !!msg);
  const el = $("result");
  el.textContent = msg || "";
  el.className = "result " + (ok ? "ok" : "ko") + (msg ? "" : " hidden");
}

async function boot() {
  st = await invoke("get_state");
  text("app-version", "v" + st.appVersion);
  if (!st.loggedIn) return showLogin();
  try {
    const me = await invoke("me");
    showMain(me);
  } catch (e) {
    if (String(e).endsWith("|unauthenticated")) return showLogin("Session expirée, reconnectez-vous.");
    showMain(null, String(e));
  }
}

function showLogin(err) {
  show("screen-main", false);
  show("screen-login", true);
  show("login-wait", false);
  $("btn-login").disabled = false;
  text("login-error", err || "");
  show("login-error", !!err);
  clearInterval(timer);
}

async function showMain(me, offlineError) {
  show("screen-login", false);
  show("screen-main", true);
  if (me) {
    $("user-avatar").src = me.avatar;
    text("user-name", me.name);
    text("user-role", ROLE[me.role] || me.role);
    if (!me.inGuild) setBanner("Vous n'êtes pas (ou plus) membre du serveur Discord : les téléchargements sont désactivés.", true);
  } else setBanner(offlineError || "Hors ligne", true);
  renderState();
  await refresh();
  clearInterval(timer);
  timer = setInterval(() => !busy && refresh(true), 5 * 60 * 1000); // nouvelle version ?
}

function renderState() {
  $("install-dir").value = st.installDir || "";
  $("channel").value = st.channel;
  $("protected").value = (st.extraProtected || []).join("\n");
  text("v-installed", st.installed ? "v" + st.installed.version : "—");
  show("btn-open", !!st.installDir);
}

async function refresh(silent) {
  if (!silent) {
    text("btn-main", "Vérification…");
    $("btn-main").disabled = true;
  }
  try {
    update = await invoke("check_updates");
    st = await invoke("get_state");
    renderState();
    renderUpdate();
  } catch (e) {
    update = null;
    text("btn-main", "Réessayer");
    $("btn-main").disabled = false;
    $("btn-main").dataset.action = "refresh";
    setResult(String(e), false);
  }
}

function renderUpdate() {
  const u = update;
  text("v-latest", "v" + u.version);
  text("changelog-title", `Nouveautés — v${u.version}${u.title ? " · " + u.title : ""}`);
  const box = $("changelog");
  box.innerHTML = "";
  if (u.summary) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = u.summary;
    box.appendChild(p);
  }
  const ul = document.createElement("ul");
  for (const c of u.changes) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "tag " + c.type;
    tag.textContent = c.type;
    const t = document.createElement("span");
    t.textContent = c.text; // textContent : jamais d'HTML venant du serveur
    li.append(tag, t);
    ul.appendChild(li);
  }
  box.appendChild(ul);

  const p = u.plan;
  const btn = $("btn-main");
  btn.dataset.action = "sync";
  btn.disabled = busy || !st.installDir;
  const dl = `${p.downloadFiles} fichier(s) à télécharger (${fmtBytes(p.downloadBytes)}), ${p.deletes.length} à supprimer`;
  switch (u.action) {
    case "install":
      text("btn-main", `Installer v${u.version}`);
      text("plan-summary", st.installDir ? `Installation complète : ${fmtBytes(u.totalSize)}, ${u.fileCount} fichiers.` : "Choisissez d'abord un dossier d'installation.");
      break;
    case "update":
      text("btn-main", `Mettre à jour vers v${u.version}`);
      text("plan-summary", `Mise à jour différentielle : ${dl}. ${p.keptProtected.length} fichier(s) protégé(s) conservé(s).`);
      setBanner(`🆕 La version v${u.version} est disponible.`, false);
      break;
    case "rollback":
      text("btn-main", `Revenir à v${u.version}`);
      text("plan-summary", `Retour à une version antérieure demandé par l'administrateur : ${dl}.`);
      setBanner(`⏪ L'administrateur a rétabli v${u.version}. Le launcher vous propose d'y revenir.`, true);
      break;
    default:
      text("btn-main", "✔ À jour");
      btn.disabled = true;
      text("plan-summary", `Tout est à jour (${p.unchanged} fichiers vérifiés, ${p.keptProtected.length} protégés).`);
      if (!$("banner").classList.contains("warn")) setBanner("");
  }
}

function setBusy(b) {
  busy = b;
  show("progress", b);
  show("actions", !b);
  $("btn-pick").disabled = b;
}

$("btn-login").onclick = async () => {
  $("btn-login").disabled = true;
  show("login-wait", true);
  show("login-error", false);
  try {
    const me = await invoke("login");
    st = await invoke("get_state");
    showMain(me);
  } catch (e) {
    showLogin(String(e) === "Connexion annulée" ? "" : String(e));
  }
};
$("btn-cancel-login").onclick = (e) => {
  e.preventDefault();
  invoke("cancel_login");
};
$("btn-logout").onclick = async () => {
  await invoke("logout");
  st = await invoke("get_state");
  showLogin();
};
$("btn-pick").onclick = async () => {
  const dir = await invoke("pick_install_dir").catch((e) => (setResult(String(e), false), null));
  if (dir) {
    st = await invoke("get_state");
    renderState();
    setResult("");
    await refresh();
  }
};
$("btn-open").onclick = () => invoke("open_install_dir").catch((e) => setResult(String(e), false));
$("btn-save-options").onclick = async () => {
  try {
    await invoke("save_options", { channel: $("channel").value, extraProtected: $("protected").value.split("\n") });
    st = await invoke("get_state");
    setResult("Options enregistrées.", true);
    await refresh();
  } catch (e) {
    setResult(String(e), false);
  }
};
$("btn-main").onclick = () => ($("btn-main").dataset.action === "refresh" ? refresh() : sync("update"));
$("btn-repair").onclick = () => {
  if (!st.installDir) return setResult("Choisissez d'abord un dossier d'installation.", false);
  sync("repair");
};
$("btn-cancel").onclick = () => invoke("cancel_sync");

async function sync(mode) {
  setResult("");
  setBusy(true);
  text("progress-phase", "Préparation…");
  $("bar-fill").style.width = "0%";
  try {
    await invoke("start_sync", { mode });
  } catch (e) {
    setBusy(false);
    setResult(String(e), false);
  }
}

listen("progress", ({ payload: p }) => {
  const pct = p.bytesTotal > 0 && p.phase === "downloading" ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100) : p.filesTotal ? Math.min(100, (p.filesDone / p.filesTotal) * 100) : 0;
  text("progress-phase", PHASE[p.phase] || p.phase);
  text("progress-pct", `${pct.toFixed(0)} %`);
  $("bar-fill").style.width = pct + "%";
  text("progress-files", p.phase === "downloading" ? `${p.filesDone}/${p.filesTotal} fichiers · ${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}` : `${p.filesDone}/${p.filesTotal} fichiers`);
  text("progress-speed", p.phase === "downloading" && p.speedBps > 0 ? `${fmtBytes(p.speedBps)}/s${p.etaSecs != null ? " · reste " + fmtEta(p.etaSecs) : ""}` : "");
  text("progress-current", p.current || "");
});

listen("sync-finished", async ({ payload: r }) => {
  setBusy(false);
  setResult(r.ok ? `✔ ${r.message}` : r.message, r.ok);
  st = await invoke("get_state");
  renderState();
  await refresh(true);
});

listen("recovered", () => setResult("Une opération précédente interrompue a été annulée : votre installation a été restaurée.", true));

boot().catch((e) => showLogin(String(e)));
