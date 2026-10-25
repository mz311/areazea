#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod secret;

use fbm_core::{compare_versions, state, updater, ApiClient, Cancel, Mode, Options, Progress, Tracker};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

/// URL du site, fixée à la compilation : `FBM_API_URL=https://mon-site.tld npm run tauri build`.
const DEFAULT_API: &str = match option_env!("FBM_API_URL") {
    Some(u) => u,
    None => "http://localhost:3000",
};

fn api_base() -> Result<String, String> {
    // en développement uniquement, on peut surcharger l'URL à l'exécution
    let base = if cfg!(debug_assertions) { std::env::var("FBM_API_URL").unwrap_or_else(|_| DEFAULT_API.to_string()) } else { DEFAULT_API.to_string() };
    let base = base.trim_end_matches('/').to_string();
    if !cfg!(debug_assertions) && !base.starts_with("https://") {
        return Err("Ce launcher doit être compilé avec une URL https (FBM_API_URL)".into());
    }
    Ok(base)
}

#[derive(Default)]
struct Shared {
    busy: AtomicBool,
    cancel: Mutex<Option<Cancel>>,
    login_abort: Mutex<Option<Arc<Notify>>>,
    last_notified: Mutex<Option<String>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    install_dir: Option<String>,
    channel: String,
    extra_protected: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { install_dir: None, channel: "STABLE".into(), extra_protected: vec![] }
    }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn load_settings(app: &AppHandle) -> Settings {
    config_dir(app).ok().and_then(|d| std::fs::read(d.join("settings.json")).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let dir = config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())
}

fn client(app: &AppHandle) -> Result<ApiClient, String> {
    let token = secret::load(&config_dir(app)?).ok_or("Non connecté")?;
    Ok(ApiClient::new(&api_base()?, &token))
}

fn err(e: fbm_core::Error) -> String {
    e.user_message()
}

// ───────────────────────────── DTO ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Installed {
    version: String,
    channel: String,
    installed_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppState {
    api_base: String,
    app_version: &'static str,
    install_dir: Option<String>,
    channel: String,
    extra_protected: Vec<String>,
    installed: Option<Installed>,
    logged_in: bool,
    busy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    channel: String,
    title: Option<String>,
    summary: Option<String>,
    published_at: Option<String>,
    total_size: u64,
    file_count: u64,
    changes: Vec<fbm_core::manifest::Change>,
    plan: fbm_core::Plan,
    installed_version: Option<String>,
    /// install | update | rollback | none
    action: &'static str,
}

fn read_installed(dir: &Option<String>) -> Option<Installed> {
    let dir = dir.as_ref()?;
    state::load(Path::new(dir)).ok().flatten().map(|s| Installed { version: s.version, channel: s.channel, installed_at: s.installed_at })
}

// ───────────────────────────── commandes ─────────────────────────────

#[tauri::command]
fn get_state(app: AppHandle, shared: State<'_, Arc<Shared>>) -> Result<AppState, String> {
    let s = load_settings(&app);
    Ok(AppState {
        api_base: api_base()?,
        app_version: env!("CARGO_PKG_VERSION"),
        installed: read_installed(&s.install_dir),
        install_dir: s.install_dir,
        channel: s.channel,
        extra_protected: s.extra_protected,
        logged_in: secret::load(&config_dir(&app)?).is_some(),
        busy: shared.busy.load(Ordering::SeqCst),
    })
}

#[tauri::command]
async fn me(app: AppHandle) -> Result<fbm_core::Me, String> {
    match client(&app)?.me().await {
        Ok(m) => Ok(m),
        Err(e @ fbm_core::Error::Api { status: 401, .. }) => {
            // jeton révoqué ou expiré : on le supprime pour redemander une connexion
            secret::clear(&config_dir(&app)?);
            Err(format!("{}|unauthenticated", err(e)))
        }
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn logout(app: AppHandle) -> Result<(), String> {
    secret::clear(&config_dir(&app)?);
    Ok(())
}

#[tauri::command]
fn cancel_login(shared: State<'_, Arc<Shared>>) {
    if let Some(n) = shared.login_abort.lock().unwrap().take() {
        n.notify_one();
    }
}

fn random_state() -> String {
    let mut b = [0u8; 18];
    getrandom::fill(&mut b).expect("RNG système");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Launcher connecté</title><body style=\"background:#050509;color:#e4e4e7;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h1 style=\"color:#a66bff\">✔ Launcher connecté</h1><p>Vous pouvez fermer cet onglet et revenir au launcher.</p></div>";

/// Connexion Discord via le site : le navigateur est ouvert sur `/launcher/auth`, puis le site redirige vers
/// `http://127.0.0.1:<port>/callback?token=…&state=…` (écoute locale, état aléatoire, 5 minutes max).
#[tauri::command]
async fn login(app: AppHandle, shared: State<'_, Arc<Shared>>) -> Result<fbm_core::Me, String> {
    let base = api_base()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let st = random_state();
    let abort = Arc::new(Notify::new());
    *shared.login_abort.lock().unwrap() = Some(abort.clone());
    app.opener().open_url(format!("{base}/launcher/auth?port={port}&state={st}"), None::<&str>).map_err(|e| e.to_string())?;

    let wait = async {
        loop {
            tokio::select! {
                _ = abort.notified() => return Err("Connexion annulée".to_string()),
                accepted = listener.accept() => {
                    let Ok((mut sock, _)) = accepted else { continue };
                    let mut buf = vec![0u8; 8192];
                    let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await { Ok(Ok(n)) => n, _ => continue };
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let line = req.lines().next().unwrap_or("");
                    let target = line.strip_prefix("GET ").and_then(|r| r.split(' ').next()).unwrap_or("");
                    let Some(query) = target.strip_prefix("/callback?") else {
                        let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
                        continue;
                    };
                    let get = |k: &str| query.split('&').find_map(|kv| kv.strip_prefix(&format!("{k}=")).map(|v| v.to_string()));
                    let (token, got_state) = (get("token"), get("state"));
                    let valid = got_state.as_deref() == Some(st.as_str())
                        && token.as_deref().map(|t| t.starts_with("fvl_") && t.len() < 200 && t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')).unwrap_or(false);
                    if !valid {
                        let _ = sock.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
                        continue;
                    }
                    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", DONE_PAGE.len(), DONE_PAGE);
                    let _ = sock.write_all(resp.as_bytes()).await;
                    return Ok(token.unwrap());
                }
            }
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(300), wait).await;
    shared.login_abort.lock().unwrap().take();
    let token = result.map_err(|_| "Délai dépassé : connexion non terminée dans le navigateur".to_string())??;

    // on vérifie le jeton avant de le conserver
    let me = ApiClient::new(&base, &token).me().await.map_err(err)?;
    secret::save(&config_dir(&app)?, &token)?;
    Ok(me)
}

#[tauri::command]
async fn pick_install_dir(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_title("Choisir le dossier d'installation de la base").blocking_pick_folder();
    let Some(p) = picked else { return Ok(None) };
    let path = p.into_path().map_err(|e| e.to_string())?;
    fbm_core::paths::validate_install_dir(&path).map_err(err)?;
    let mut s = load_settings(&app);
    s.install_dir = Some(path.to_string_lossy().to_string());
    save_settings(&app, &s)?;
    Ok(s.install_dir)
}

#[tauri::command]
fn save_options(app: AppHandle, channel: String, extra_protected: Vec<String>) -> Result<(), String> {
    if !matches!(channel.as_str(), "STABLE" | "BETA") {
        return Err("Canal invalide".into());
    }
    let extra: Vec<String> = extra_protected.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    for p in &extra {
        if p.len() > 200 || p.contains('\\') || p.starts_with('/') {
            return Err(format!("Motif invalide : {p} (utilisez / et un chemin relatif)"));
        }
    }
    let mut s = load_settings(&app);
    s.channel = channel;
    s.extra_protected = extra;
    save_settings(&app, &s)
}

fn options(s: &Settings) -> Options {
    Options { extra_protected: s.extra_protected.clone(), ..Options::default() }
}

#[tauri::command]
async fn check_updates(app: AppHandle, shared: State<'_, Arc<Shared>>) -> Result<UpdateInfo, String> {
    let s = load_settings(&app);
    let api = client(&app)?;
    let remote = api.latest(&s.channel, None).await.map_err(err)?;
    let installed = read_installed(&s.install_dir);
    let plan = match &s.install_dir {
        Some(dir) if !shared.busy.load(Ordering::SeqCst) => {
            updater::plan(Path::new(dir), &remote.manifest, Mode::Update, &options(&s), &Tracker::silent(), &Cancel::new()).await.map_err(err)?
        }
        // pas encore de dossier choisi : tout est à télécharger
        _ => fbm_core::Plan {
            writes: remote.manifest.files.clone(),
            download_bytes: remote.total_size,
            download_files: remote.manifest.files.len(),
            ..Default::default()
        },
    };
    let action = match &installed {
        None => "install",
        Some(i) if compare_versions(&remote.version, &i.version).is_lt() => "rollback",
        Some(i) if i.version != remote.version || !plan.is_noop() => "update",
        _ => "none",
    };
    // notification native, une seule fois par version
    if matches!(action, "update") {
        let mut last = shared.last_notified.lock().unwrap();
        if last.as_deref() != Some(remote.version.as_str()) {
            *last = Some(remote.version.clone());
            let _ = app.notification().builder().title("Mise à jour disponible").body(format!("La version v{} est disponible.", remote.version)).show();
        }
    }
    Ok(UpdateInfo {
        version: remote.version,
        channel: remote.channel,
        title: remote.title,
        summary: remote.summary,
        published_at: remote.published_at,
        total_size: remote.total_size,
        file_count: remote.file_count,
        changes: remote.changes,
        plan,
        installed_version: installed.map(|i| i.version),
        action,
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Finished {
    ok: bool,
    cancelled: bool,
    message: String,
    report: Option<fbm_core::SyncReport>,
}

/// Lance une installation / mise à jour / réparation en tâche de fond ; la progression est émise via l'événement `progress`.
#[tauri::command]
fn start_sync(app: AppHandle, shared: State<'_, Arc<Shared>>, mode: String) -> Result<(), String> {
    let settings = load_settings(&app);
    let dir = PathBuf::from(settings.install_dir.clone().ok_or("Choisissez d'abord un dossier d'installation")?);
    let api = client(&app)?;
    let repair = mode == "repair";
    if shared.busy.swap(true, Ordering::SeqCst) {
        return Err("Une opération est déjà en cours".into());
    }
    let cancel = Cancel::new();
    *shared.cancel.lock().unwrap() = Some(cancel.clone());
    let shared = shared.inner().clone();

    tauri::async_runtime::spawn(async move {
        let emit_app = app.clone();
        let tracker = Tracker::new(Arc::new(move |p: Progress| {
            let _ = emit_app.emit("progress", p);
        }));
        let outcome: Result<(fbm_core::SyncReport, bool), fbm_core::Error> = async {
            let restored = if dir.exists() { updater::recover(&dir)? } else { false };
            let _ = restored;
            let installed_before = state::load(&dir).ok().flatten();
            let remote = api.latest(&settings.channel, None).await?;
            let opts = options(&settings);
            let m = if repair { Mode::Repair } else { Mode::Update };
            let plan = updater::plan(&dir, &remote.manifest, m, &opts, &tracker, &cancel).await?;
            let report = updater::apply(&dir, &remote.version, &remote.channel, &remote.manifest, &plan, &api, api.http(), &opts, &tracker, &cancel).await?;
            let kind = if repair { "REPAIR" } else if installed_before.is_none() { "INSTALL" } else { "UPDATE" };
            let _ = api.report(&remote.version, kind).await; // statistiques : erreurs ignorées
            Ok((report, installed_before.is_none()))
        }
        .await;
        let finished = match outcome {
            Ok((report, _)) => Finished { ok: true, cancelled: false, message: format!("v{} installée.", report.version), report: Some(report) },
            Err(fbm_core::Error::Cancelled) => Finished { ok: false, cancelled: true, message: "Opération annulée. Votre installation n'a pas été modifiée.".into(), report: None },
            Err(e) => Finished { ok: false, cancelled: false, message: format!("{} Votre installation a été restaurée telle qu'avant.", e.user_message()), report: None },
        };
        shared.cancel.lock().unwrap().take();
        shared.busy.store(false, Ordering::SeqCst);
        let _ = app.emit("sync-finished", finished);
    });
    Ok(())
}

#[tauri::command]
fn cancel_sync(shared: State<'_, Arc<Shared>>) {
    if let Some(c) = shared.cancel.lock().unwrap().as_ref() {
        c.cancel();
    }
}

#[tauri::command]
fn open_install_dir(app: AppHandle) -> Result<(), String> {
    let dir = load_settings(&app).install_dir.ok_or("Aucun dossier d'installation")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(Shared::default()))
        .setup(|app| {
            // reprise après un arrêt brutal : annule toute transaction interrompue
            let handle = app.handle().clone();
            if let Some(dir) = load_settings(&handle).install_dir {
                let p = PathBuf::from(dir);
                if p.exists() {
                    if let Ok(true) = updater::recover(&p) {
                        let _ = handle.emit("recovered", ());
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_state, me, login, cancel_login, logout, pick_install_dir, save_options, check_updates, start_sync, cancel_sync, open_install_dir])
        .run(tauri::generate_context!())
        .expect("erreur au lancement du launcher");
}
