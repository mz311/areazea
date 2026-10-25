use crate::api::Source;
use crate::error::{Error, IoCtx, Result};
use crate::manifest::{is_valid_sha256, Manifest, ManifestFile};
use crate::paths::{ensure_no_symlink_parents, is_managed, safe_join, validate_install_dir, validate_rel, Globs};
use crate::progress::{Cancel, Phase, Tracker};
use crate::state::{self, fbm_dir, FileRecord, InstallState};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Se fie à l'état local : ne re-hache pas les fichiers déjà connus et inchangés.
    Update,
    /// Re-hache tous les fichiers et retélécharge ceux qui sont absents ou corrompus.
    Repair,
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Motifs glob supplémentaires (en plus de ceux du manifeste) à ne jamais écraser ni supprimer.
    pub extra_protected: Vec<String>,
    pub concurrency: usize,
    pub max_retries: u32,
    /// Re-hache chaque fichier écrit après l'application (annule tout en cas de différence).
    pub verify_after: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { extra_protected: vec![], concurrency: 4, max_retries: 3, verify_after: true }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Fichiers à écrire (nouveaux ou modifiés), chemin → hash.
    pub writes: Vec<ManifestFile>,
    /// Fichiers installés précédemment par le launcher, absents de la nouvelle version, dans un dossier géré.
    pub deletes: Vec<String>,
    /// Fichiers protégés existants : conservés tels quels.
    pub kept_protected: Vec<String>,
    pub unchanged: usize,
    /// Octets à télécharger (blobs uniques).
    pub download_bytes: u64,
    pub download_files: usize,
}

impl Plan {
    pub fn is_noop(&self) -> bool {
        self.writes.is_empty() && self.deletes.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub version: String,
    pub downloaded_files: usize,
    pub downloaded_bytes: u64,
    pub written: usize,
    pub deleted: usize,
    pub kept_protected: usize,
    pub unchanged: usize,
}

fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut n_total = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        n_total += n as u64;
    }
    Ok((hex::encode(h.finalize()), n_total))
}

async fn hash_file_async(path: PathBuf) -> std::io::Result<(String, u64)> {
    tokio::task::spawn_blocking(move || hash_file(&path)).await.map_err(|e| std::io::Error::other(e.to_string()))?
}

fn validate_manifest(m: &Manifest) -> Result<()> {
    let mut seen = HashSet::new();
    for f in &m.files {
        validate_rel(&f.path)?;
        if !is_valid_sha256(&f.sha256) {
            return Err(Error::Integrity(format!("hash invalide pour {}", f.path)));
        }
        if !seen.insert(f.path.to_ascii_lowercase()) {
            return Err(Error::Integrity(format!("chemin en double dans le manifeste : {}", f.path)));
        }
    }
    Ok(())
}

/// Compare l'installation locale au manifeste distant.
pub async fn plan(dir: &Path, remote: &Manifest, mode: Mode, opts: &Options, tracker: &Tracker, cancel: &Cancel) -> Result<Plan> {
    validate_install_dir(dir)?;
    validate_manifest(remote)?;
    let old = state::load(dir)?;
    let protected = Globs::new(remote.protected.iter().chain(opts.extra_protected.iter()));
    tracker.update(|p| {
        p.phase = Phase::Checking;
        p.files_total = remote.files.len();
        p.files_done = 0;
    }, true);

    enum Verdict {
        Write(ManifestFile),
        Keep(String),
        Same,
    }

    let results: Vec<Result<Verdict>> = stream::iter(remote.files.iter().cloned())
        .map(|f| {
            let old_rec = old.as_ref().and_then(|s| s.files.get(&f.path).cloned());
            let is_prot = protected.matches(&f.path);
            let dir = dir.to_path_buf();
            let tracker = tracker.clone();
            let cancel = cancel.clone();
            async move {
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let path = safe_join(&dir, &f.path)?;
                ensure_no_symlink_parents(&dir, &path)?;
                let meta = tokio::fs::symlink_metadata(&path).await.ok();
                let exists = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
                if meta.as_ref().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                    return Err(Error::UnsafePath(format!("{} est un lien symbolique", f.path)));
                }
                let verdict = if is_prot && exists {
                    Verdict::Keep(f.path.clone())
                } else if !exists {
                    Verdict::Write(f)
                } else {
                    let trusted = mode == Mode::Update
                        && old_rec.as_ref().map(|r| r.sha256 == f.sha256 && r.size == f.size).unwrap_or(false)
                        && meta.as_ref().map(|m| m.len() == f.size).unwrap_or(false);
                    if trusted {
                        Verdict::Same
                    } else {
                        let (h, _) = hash_file_async(path).await.map_err(|e| Error::io(format!("lecture de {}", f.path), e))?;
                        if h == f.sha256 {
                            Verdict::Same
                        } else {
                            Verdict::Write(f)
                        }
                    }
                };
                tracker.file_done(None);
                Ok(verdict)
            }
        })
        .buffer_unordered(8)
        .collect()
        .await;

    let mut plan = Plan::default();
    for r in results {
        match r? {
            Verdict::Write(f) => plan.writes.push(f),
            Verdict::Keep(p) => plan.kept_protected.push(p),
            Verdict::Same => plan.unchanged += 1,
        }
    }
    plan.writes.sort_by(|a, b| a.path.cmp(&b.path));
    plan.kept_protected.sort();

    // Suppression des fichiers obsolètes : uniquement ceux installés par le launcher (présents dans l'état),
    // situés dans un dossier géré, non protégés.
    if let Some(old) = &old {
        let keep: HashSet<&str> = remote.files.iter().map(|f| f.path.as_str()).collect();
        for path in old.files.keys() {
            if keep.contains(path.as_str()) || protected.matches(path) || !is_managed(path, &remote.managed_dirs) {
                continue;
            }
            let Ok(p) = safe_join(dir, path) else { continue };
            if ensure_no_symlink_parents(dir, &p).is_err() {
                continue;
            }
            if tokio::fs::symlink_metadata(&p).await.map(|m| m.is_file()).unwrap_or(false) {
                plan.deletes.push(path.clone());
            }
        }
        plan.deletes.sort();
    }

    let mut unique: HashMap<&str, u64> = HashMap::new();
    for f in &plan.writes {
        unique.insert(&f.sha256, f.size);
    }
    plan.download_files = unique.len();
    plan.download_bytes = unique.values().sum();
    Ok(plan)
}

// ───────────────────────────── journal & transaction ─────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct Op {
    path: String,
    write: bool,
    had_original: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    id: String,
    committing: bool,
    ops: Vec<Op>,
}

fn journal_path(dir: &Path) -> PathBuf {
    fbm_dir(dir).join("txn.json")
}

fn write_journal(dir: &Path, j: &Journal) -> Result<()> {
    let p = journal_path(dir);
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(j).expect("json")).ctx(|| "écriture du journal".into())?;
    std::fs::rename(&tmp, &p).ctx(|| "validation du journal".into())
}

fn txn_dirs(dir: &Path, id: &str) -> (PathBuf, PathBuf) {
    (fbm_dir(dir).join("staging").join(id), fbm_dir(dir).join("backup").join(id))
}

fn rollback_ops(dir: &Path, j: &Journal) {
    let (_, backup) = txn_dirs(dir, &j.id);
    for op in j.ops.iter().rev() {
        let Ok(target) = safe_join(dir, &op.path) else { continue };
        if op.write {
            let _ = std::fs::remove_file(&target);
        }
        if op.had_original {
            let saved = backup.join(op.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if saved.exists() {
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::remove_file(&target);
                let _ = std::fs::rename(&saved, &target);
            }
        }
    }
}

fn cleanup_txn(dir: &Path, id: &str) {
    let (staging, backup) = txn_dirs(dir, id);
    let _ = std::fs::remove_dir_all(staging);
    let _ = std::fs::remove_dir_all(backup);
    let _ = std::fs::remove_file(journal_path(dir));
    // supprime les dossiers parents vides
    let _ = std::fs::remove_dir(fbm_dir(dir).join("staging"));
    let _ = std::fs::remove_dir(fbm_dir(dir).join("backup"));
}

/// À appeler au démarrage : si une opération précédente a été interrompue (crash, coupure), restaure l'état antérieur.
/// Retourne `true` si une restauration a eu lieu.
pub fn recover(dir: &Path) -> Result<bool> {
    let p = journal_path(dir);
    let Ok(bytes) = std::fs::read(&p) else { return Ok(false) };
    let Ok(j) = serde_json::from_slice::<Journal>(&bytes) else {
        let _ = std::fs::remove_file(&p);
        return Ok(false);
    };
    let restored = j.committing;
    if j.committing {
        rollback_ops(dir, &j);
    }
    cleanup_txn(dir, &j.id);
    Ok(restored)
}

fn new_txn_id() -> String {
    format!("{:x}-{:x}", state::now_secs(), std::process::id())
}

// ───────────────────────────── téléchargement ─────────────────────────────

enum Dl {
    Expired,
    Retry(Error),
    Fatal(Error),
}

async fn download_one(http: &reqwest::Client, url: &str, dest: &Path, sha: &str, size: u64, tracker: &Tracker, cancel: &Cancel) -> std::result::Result<(), Dl> {
    let res = http.get(url).send().await.map_err(|e| Dl::Retry(e.into()))?;
    let status = res.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Dl::Expired);
    }
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(Dl::Retry(Error::Other(format!("le serveur de fichiers a répondu {status}"))));
    }
    if !status.is_success() {
        return Err(Dl::Fatal(Error::Other(format!("téléchargement refusé ({status})"))));
    }
    let part = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| Dl::Fatal(Error::io("création du fichier temporaire", e)))?;
    let mut hasher = Sha256::new();
    let mut got = 0u64;
    let mut stream = res.bytes_stream();
    let fail = |tracker: &Tracker, got: u64, e: Dl| {
        tracker.sub_bytes(got);
        e
    };
    while let Some(chunk) = stream.next().await {
        if cancel.is_cancelled() {
            return Err(fail(tracker, got, Dl::Fatal(Error::Cancelled)));
        }
        let chunk = chunk.map_err(|e| fail(tracker, got, Dl::Retry(e.into())))?;
        got += chunk.len() as u64;
        if got > size {
            return Err(fail(tracker, got, Dl::Retry(Error::Integrity("fichier plus grand que prévu".into()))));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| fail(tracker, got, Dl::Fatal(Error::io("écriture", e))))?;
        tracker.add_bytes(chunk.len() as u64);
    }
    file.flush().await.map_err(|e| fail(tracker, got, Dl::Fatal(Error::io("écriture", e))))?;
    drop(file);
    if got != size || hex::encode(hasher.finalize()) != sha {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(fail(tracker, got, Dl::Retry(Error::Integrity(format!("SHA-256 incorrect pour le blob {}…", &sha[..12])))));
    }
    tokio::fs::rename(&part, dest).await.map_err(|e| Dl::Fatal(Error::io("finalisation du téléchargement", e)))?;
    Ok(())
}

async fn download_blob<S: Source>(
    source: &S,
    http: &reqwest::Client,
    version: &str,
    first_url: String,
    dest: PathBuf,
    sha: &str,
    size: u64,
    tracker: &Tracker,
    cancel: &Cancel,
    max_retries: u32,
) -> Result<()> {
    let mut url = first_url;
    let mut last: Option<Error> = None;
    for attempt in 0..=max_retries {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        match download_one(http, &url, &dest, sha, size, tracker, cancel).await {
            Ok(()) => return Ok(()),
            Err(Dl::Fatal(e)) => return Err(e),
            Err(Dl::Expired) => {
                // lien temporaire expiré : on en redemande un
                let mut m = source.blob_urls(version, &[sha.to_string()]).await?;
                url = m.remove(sha).ok_or_else(|| Error::Other("lien de téléchargement non fourni".into()))?;
                last = Some(Error::Other("lien de téléchargement expiré".into()));
            }
            Err(Dl::Retry(e)) => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(400 * (1 << attempt.min(4)))).await;
            }
        }
    }
    Err(last.unwrap_or_else(|| Error::Other("échec du téléchargement".into())))
}

// ───────────────────────────── application ─────────────────────────────

/// Applique un plan : téléchargement vérifié → sauvegarde des fichiers remplacés → écriture → vérification →
/// état. Toute erreur (réseau, disque, intégrité, annulation) restaure l'installation à l'identique.
pub async fn apply<S: Source>(
    dir: &Path,
    version: &str,
    channel: &str,
    remote: &Manifest,
    plan: &Plan,
    source: &S,
    http: &reqwest::Client,
    opts: &Options,
    tracker: &Tracker,
    cancel: &Cancel,
) -> Result<SyncReport> {
    validate_install_dir(dir)?;
    std::fs::create_dir_all(dir).ctx(|| format!("création de {}", dir.display()))?;
    let id = new_txn_id();
    let (staging, backup) = txn_dirs(dir, &id);
    std::fs::create_dir_all(&staging).ctx(|| "création du dossier temporaire".into())?;
    write_journal(dir, &Journal { id: id.clone(), committing: false, ops: vec![] })?;

    let result = run_apply(dir, version, channel, remote, plan, source, http, opts, tracker, cancel, &id, &staging, &backup).await;
    match result {
        Ok(report) => {
            cleanup_txn(dir, &id);
            tracker.phase(Phase::Done);
            Ok(report)
        }
        Err(e) => {
            // la restauration éventuelle a déjà eu lieu dans run_apply ; on nettoie le reste
            cleanup_txn(dir, &id);
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_apply<S: Source>(
    dir: &Path,
    version: &str,
    channel: &str,
    remote: &Manifest,
    plan: &Plan,
    source: &S,
    http: &reqwest::Client,
    opts: &Options,
    tracker: &Tracker,
    cancel: &Cancel,
    id: &str,
    staging: &Path,
    backup: &Path,
) -> Result<SyncReport> {
    // 1. téléchargement des blobs uniques dans le dossier temporaire
    let mut unique: BTreeMap<String, u64> = BTreeMap::new();
    for f in &plan.writes {
        unique.insert(f.sha256.clone(), f.size);
    }
    tracker.update(
        |p| {
            p.phase = Phase::Downloading;
            p.bytes_total = plan.download_bytes;
            p.bytes_done = 0;
            p.files_total = unique.len();
            p.files_done = 0;
            p.current = None;
        },
        true,
    );
    let blobs: Vec<(String, u64)> = unique.into_iter().collect();
    let names: HashMap<&str, &str> = plan.writes.iter().map(|f| (f.sha256.as_str(), f.path.as_str())).collect();
    for chunk in blobs.chunks(100) {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let hashes: Vec<String> = chunk.iter().map(|(h, _)| h.clone()).collect();
        let urls = source.blob_urls(version, &hashes).await?;
        // éléments possédés (et non des références) : évite une limite de rustc sur les closures async « higher-ranked »
        let results: Vec<Result<()>> = stream::iter(chunk.to_vec())
            .map(|(sha, size)| {
                let url = urls.get(&sha).cloned();
                let dest = staging.join(&sha);
                let label = names.get(sha.as_str()).map(|s| s.to_string());
                async move {
                    let url = url.ok_or_else(|| Error::Other(format!("aucun lien pour le blob {}…", &sha[..12])))?;
                    download_blob(source, http, version, url, dest, &sha, size, tracker, cancel, opts.max_retries).await?;
                    tracker.file_done(label);
                    Ok(())
                }
            })
            .buffer_unordered(opts.concurrency.max(1))
            .collect()
            .await;
        for r in results {
            r?;
        }
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }

    // 2. journal des opérations, puis application avec restauration automatique en cas d'erreur
    tracker.update(
        |p| {
            p.phase = Phase::Applying;
            p.files_total = plan.writes.len() + plan.deletes.len();
            p.files_done = 0;
        },
        true,
    );
    let mut ops = Vec::new();
    for f in &plan.writes {
        let t = safe_join(dir, &f.path)?;
        ensure_no_symlink_parents(dir, &t)?;
        ops.push(Op { path: f.path.clone(), write: true, had_original: t.is_file() });
    }
    for p in &plan.deletes {
        let t = safe_join(dir, p)?;
        ops.push(Op { path: p.clone(), write: false, had_original: t.is_file() });
    }
    let journal = Journal { id: id.to_string(), committing: true, ops };
    write_journal(dir, &journal)?;

    if let Err(e) = commit(dir, &journal, plan, staging, backup, opts, tracker) {
        tracker.phase(Phase::RollingBack);
        rollback_ops(dir, &journal);
        return Err(e);
    }

    // 3. nouvel état d'installation
    let new_state = build_state(dir, version, channel, remote, plan);
    if let Err(e) = state::save(dir, &new_state) {
        tracker.phase(Phase::RollingBack);
        rollback_ops(dir, &journal);
        return Err(e);
    }
    Ok(SyncReport {
        version: version.to_string(),
        downloaded_files: plan.download_files,
        downloaded_bytes: plan.download_bytes,
        written: plan.writes.len(),
        deleted: plan.deletes.len(),
        kept_protected: plan.kept_protected.len(),
        unchanged: plan.unchanged,
    })
}

fn commit(dir: &Path, journal: &Journal, plan: &Plan, staging: &Path, backup: &Path, opts: &Options, tracker: &Tracker) -> Result<()> {
    // sauvegarde des fichiers remplacés / supprimés
    for op in journal.ops.iter().filter(|o| o.had_original) {
        let target = safe_join(dir, &op.path)?;
        let saved = backup.join(op.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = saved.parent() {
            std::fs::create_dir_all(parent).ctx(|| "création de la sauvegarde".into())?;
        }
        std::fs::rename(&target, &saved).ctx(|| format!("sauvegarde de {}", op.path))?;
    }
    // écriture : on déplace le blob pour sa dernière utilisation, on copie pour les doublons
    let mut remaining: HashMap<&str, usize> = HashMap::new();
    for f in &plan.writes {
        *remaining.entry(&f.sha256).or_default() += 1;
    }
    for f in &plan.writes {
        let target = safe_join(dir, &f.path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).ctx(|| format!("création du dossier de {}", f.path))?;
        }
        let src = staging.join(&f.sha256);
        let left = remaining.get_mut(f.sha256.as_str()).expect("compteur");
        if *left == 1 {
            std::fs::rename(&src, &target).ctx(|| format!("installation de {}", f.path))?;
        } else {
            std::fs::copy(&src, &target).ctx(|| format!("installation de {}", f.path))?;
        }
        *left -= 1;
        tracker.file_done(Some(f.path.clone()));
    }
    // suppression des dossiers devenus vides (jamais le dossier géré lui-même)
    for p in &plan.deletes {
        tracker.file_done(Some(p.clone()));
        let mut cur = safe_join(dir, p)?.parent().map(|d| d.to_path_buf());
        while let Some(d) = cur {
            if d == dir || d.parent() == Some(dir) || std::fs::remove_dir(&d).is_err() {
                break;
            }
            cur = d.parent().map(|x| x.to_path_buf());
        }
    }
    // vérification finale des fichiers écrits
    if opts.verify_after {
        tracker.update(
            |p| {
                p.phase = Phase::Verifying;
                p.files_total = plan.writes.len();
                p.files_done = 0;
            },
            true,
        );
        for f in &plan.writes {
            let target = safe_join(dir, &f.path)?;
            let (h, n) = hash_file(&target).ctx(|| format!("vérification de {}", f.path))?;
            if h != f.sha256 || n != f.size {
                return Err(Error::Integrity(format!("{} est incorrect après écriture", f.path)));
            }
            tracker.file_done(Some(f.path.clone()));
        }
    }
    Ok(())
}

fn build_state(dir: &Path, version: &str, channel: &str, remote: &Manifest, plan: &Plan) -> InstallState {
    let kept: HashSet<&str> = plan.kept_protected.iter().map(|s| s.as_str()).collect();
    let mut files = BTreeMap::new();
    for f in &remote.files {
        // un fichier protégé conservé appartient à l'utilisateur : on ne le suit pas
        if kept.contains(f.path.as_str()) {
            continue;
        }
        files.insert(f.path.clone(), FileRecord { sha256: f.sha256.clone(), size: f.size });
    }
    let _ = dir;
    InstallState { version: version.to_string(), channel: channel.to_string(), installed_at: state::now_secs(), files }
}

/// Planification + application.
pub async fn sync<S: Source>(
    dir: &Path,
    remote_version: &str,
    channel: &str,
    remote: &Manifest,
    source: &S,
    http: &reqwest::Client,
    mode: Mode,
    opts: &Options,
    tracker: &Tracker,
    cancel: &Cancel,
) -> Result<SyncReport> {
    validate_install_dir(dir)?;
    if dir.exists() {
        recover(dir)?;
    }
    let p = plan(dir, remote, mode, opts, tracker, cancel).await?;
    apply(dir, remote_version, channel, remote, &p, source, http, opts, tracker, cancel).await
}
