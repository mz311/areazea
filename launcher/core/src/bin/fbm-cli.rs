//! Launcher en ligne de commande (tests, serveurs Linux/CI, utilisateurs avancés).
//!
//!   fbm-cli --api https://site --token fvl_… --dir /chemin [--channel STABLE|BETA] [--version X]
//!           [--protect "motif"]… [--dry-run] <status|update|repair|recover>

use fbm_core::{updater, ApiClient, Cancel, Mode, Options, Phase, Tracker};
use std::path::PathBuf;
use std::sync::Arc;

struct Args {
    api: String,
    token: String,
    dir: PathBuf,
    channel: String,
    version: Option<String>,
    protect: Vec<String>,
    dry_run: bool,
    cmd: String,
}

fn parse() -> Result<Args, String> {
    let mut a = Args {
        api: std::env::var("FBM_API").unwrap_or_default(),
        token: std::env::var("FBM_TOKEN").unwrap_or_default(),
        dir: PathBuf::new(),
        channel: "STABLE".into(),
        version: None,
        protect: vec![],
        dry_run: false,
        cmd: "update".into(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = |name: &str| it.next().ok_or(format!("{name} attend une valeur"));
        match arg.as_str() {
            "--api" => a.api = val("--api")?,
            "--token" => a.token = val("--token")?,
            "--dir" => a.dir = PathBuf::from(val("--dir")?),
            "--channel" => a.channel = val("--channel")?,
            "--version" => a.version = Some(val("--version")?),
            "--protect" => a.protect.push(val("--protect")?),
            "--dry-run" => a.dry_run = true,
            c @ ("status" | "update" | "repair" | "recover") => a.cmd = c.to_string(),
            other => return Err(format!("argument inconnu : {other}")),
        }
    }
    if a.dir.as_os_str().is_empty() {
        return Err("--dir est requis".into());
    }
    if a.cmd != "recover" && (a.api.is_empty() || a.token.is_empty()) {
        return Err("--api et --token (ou FBM_API / FBM_TOKEN) sont requis".into());
    }
    Ok(a)
}

fn human(n: u64) -> String {
    let units = ["o", "Ko", "Mo", "Go"];
    let (mut v, mut i) = (n as f64, 0);
    while v >= 1024.0 && i < 3 {
        v /= 1024.0;
        i += 1;
    }
    format!("{v:.1} {}", units[i])
}

#[tokio::main]
async fn main() {
    let a = match parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Erreur : {e}\nUsage : fbm-cli --api URL --token TOKEN --dir DOSSIER [--channel STABLE|BETA] [--version X] [--protect GLOB]… [--dry-run] <status|update|repair|recover>");
            std::process::exit(2);
        }
    };
    if let Err(e) = run(a).await {
        eprintln!("ÉCHEC : {}", e.user_message());
        std::process::exit(1);
    }
}

async fn run(a: Args) -> fbm_core::Result<()> {
    if a.cmd == "recover" {
        println!("{}", if updater::recover(&a.dir)? { "installation restaurée (opération interrompue annulée)" } else { "rien à restaurer" });
        return Ok(());
    }
    let api = ApiClient::new(&a.api, &a.token);
    let me = api.me().await?;
    println!("Connecté : {} ({}, serveur Discord : {})", me.name, me.role, if me.in_guild { "oui" } else { "non" });
    let installed = fbm_core::state::load(&a.dir)?;
    println!("Installé : {}", installed.as_ref().map(|s| format!("v{} ({})", s.version, s.channel)).unwrap_or_else(|| "aucune".into()));
    let remote = api.latest(&a.channel, a.version.as_deref()).await?;
    println!("Cible    : v{} ({} fichiers, {})", remote.version, remote.file_count, human(remote.total_size));

    let opts = Options { extra_protected: a.protect.clone(), ..Options::default() };
    let mode = if a.cmd == "repair" { Mode::Repair } else { Mode::Update };
    let tracker = Tracker::new(Arc::new(|p| {
        if matches!(p.phase, Phase::Downloading) {
            eprint!("\r  téléchargement {}/{} fichiers · {} / {} · {}/s   ", p.files_done, p.files_total, human(p.bytes_done), human(p.bytes_total), human(p.speed_bps as u64));
        }
    }));
    let cancel = Cancel::new();
    if let Ok(true) = fbm_core::updater::recover(&a.dir).map(|r| r) {
        println!("(une opération précédente interrompue a été annulée)");
    }
    let plan = updater::plan(&a.dir, &remote.manifest, mode, &opts, &tracker, &cancel).await?;
    println!("Plan     : {} à écrire ({} à télécharger, {}), {} à supprimer, {} protégés conservés, {} inchangés", plan.writes.len(), plan.download_files, human(plan.download_bytes), plan.deletes.len(), plan.kept_protected.len(), plan.unchanged);
    if a.cmd == "status" || a.dry_run {
        return Ok(());
    }
    if plan.is_noop() && installed.as_ref().map(|s| s.version == remote.version).unwrap_or(false) {
        println!("Déjà à jour.");
        return Ok(());
    }
    let report = updater::apply(&a.dir, &remote.version, &remote.channel, &remote.manifest, &plan, &api, api.http(), &opts, &tracker, &cancel).await?;
    eprintln!();
    let kind = match (&installed, a.cmd.as_str()) {
        (_, "repair") => "REPAIR",
        (None, _) => "INSTALL",
        _ => "UPDATE",
    };
    let _ = api.report(&remote.version, kind).await;
    println!("OK : v{} — {} écrits, {} supprimés, {} téléchargés ({})", report.version, report.written, report.deleted, report.downloaded_files, human(report.downloaded_bytes));
    Ok(())
}
