//! Tests d'intégration du moteur : serveur HTTP local (tiny_http) servant les blobs.

use fbm_core::api::{http_client, Source};
use fbm_core::manifest::{Manifest, ManifestFile};
use fbm_core::paths::{glob_to_regex, validate_rel};
use fbm_core::progress::{Cancel, Tracker};
use fbm_core::state;
use fbm_core::updater::{self, Mode, Options};
use fbm_core::{Error, Result};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// Faux serveur de fichiers : blobs en mémoire, compteur de requêtes, option de corruption.
struct Blobs {
    port: u16,
    store: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    hits: Arc<AtomicUsize>,
    corrupt: Arc<Mutex<Option<String>>>,
    url_calls: Arc<AtomicUsize>,
}

impl Blobs {
    fn start() -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let store: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
        let hits = Arc::new(AtomicUsize::new(0));
        let corrupt: Arc<Mutex<Option<String>>> = Arc::default();
        let (s, h, c) = (store.clone(), hits.clone(), corrupt.clone());
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let key = req.url().trim_start_matches("/blob/").to_string();
                h.fetch_add(1, Ordering::SeqCst);
                let data = s.lock().unwrap().get(&key).cloned();
                match data {
                    Some(mut d) => {
                        if c.lock().unwrap().as_deref() == Some(key.as_str()) {
                            d[0] ^= 0xff; // corruption en transit
                        }
                        let _ = req.respond(tiny_http::Response::from_data(d));
                    }
                    None => {
                        let _ = req.respond(tiny_http::Response::from_string("nope").with_status_code(404));
                    }
                }
            }
        });
        Blobs { port, store, hits, corrupt, url_calls: Arc::new(AtomicUsize::new(0)) }
    }

    fn add(&self, content: &str) -> ManifestFile {
        let h = sha(content.as_bytes());
        self.store.lock().unwrap().insert(h.clone(), content.as_bytes().to_vec());
        ManifestFile { path: String::new(), sha256: h, size: content.len() as u64 }
    }
}

impl Source for Blobs {
    async fn blob_urls(&self, _version: &str, hashes: &[String]) -> Result<HashMap<String, String>> {
        self.url_calls.fetch_add(1, Ordering::SeqCst);
        Ok(hashes.iter().map(|h| (h.clone(), format!("http://127.0.0.1:{}/blob/{h}", self.port))).collect())
    }
}

fn manifest(blobs: &Blobs, files: &[(&str, &str)], protected: &[&str]) -> Manifest {
    let mut fs: Vec<ManifestFile> = files
        .iter()
        .map(|(p, c)| {
            let mut f = blobs.add(c);
            f.path = p.to_string();
            f
        })
        .collect();
    fs.sort_by(|a, b| a.path.cmp(&b.path));
    Manifest { files: fs, managed_dirs: vec!["resources".into()], protected: protected.iter().map(|s| s.to_string()).collect() }
}

async fn run(dir: &Path, blobs: &Blobs, version: &str, m: &Manifest, mode: Mode) -> Result<updater::SyncReport> {
    updater::sync(dir, version, "STABLE", m, blobs, &http_client(), mode, &Options::default(), &Tracker::silent(), &Cancel::new()).await
}

fn read(dir: &Path, rel: &str) -> String {
    std::fs::read_to_string(dir.join(rel)).unwrap_or_else(|_| "<absent>".into())
}

fn no_leftovers(dir: &Path) {
    let fbm = dir.join(".fbm");
    assert!(!fbm.join("txn.json").exists(), "journal laissé");
    assert!(!fbm.join("staging").exists(), "staging laissé");
    assert!(!fbm.join("backup").exists(), "backup laissé");
}

const PROT: [&str; 2] = ["server.cfg", "**/config.lua"];

#[tokio::test]
async fn fresh_install_writes_all_files_and_state() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let m = manifest(&blobs, &[("server.cfg", "cfg-default"), ("resources/core/main.lua", "print(1)"), ("resources/core/config.lua", "Config={}")], &PROT);
    let r = run(dir.path(), &blobs, "1.0.0", &m, Mode::Update).await.unwrap();
    assert_eq!((r.written, r.deleted, r.downloaded_files), (3, 0, 3));
    assert_eq!(read(dir.path(), "resources/core/main.lua"), "print(1)");
    assert_eq!(read(dir.path(), "server.cfg"), "cfg-default"); // protégé mais absent : installé
    let st = state::load(dir.path()).unwrap().unwrap();
    assert_eq!(st.version, "1.0.0");
    assert_eq!(st.files.len(), 3);
    no_leftovers(dir.path());
}

#[tokio::test]
async fn differential_update_downloads_only_changes_and_protects_user_files() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let v1 = manifest(
        &blobs,
        &[("server.cfg", "cfg-v1"), ("resources/a/a.lua", "A1"), ("resources/a/config.lua", "cfgA-v1"), ("resources/old/old.lua", "OLD"), ("resources/same/s.lua", "SAME"), ("readme.txt", "r1")],
        &PROT,
    );
    run(dir.path(), &blobs, "1.0.0", &v1, Mode::Update).await.unwrap();

    // l'utilisateur personnalise sa config, ajoute ses propres fichiers
    std::fs::write(dir.path().join("server.cfg"), "MON-SERVEUR").unwrap();
    std::fs::write(dir.path().join("resources/a/config.lua"), "MA-CONFIG").unwrap();
    std::fs::create_dir_all(dir.path().join("resources/mon-script")).unwrap();
    std::fs::write(dir.path().join("resources/mon-script/x.lua"), "PERSO").unwrap();
    std::fs::write(dir.path().join("notes-perso.txt"), "PERSO").unwrap();

    // v2 : a.lua modifié, config modifiée (protégée), old supprimé, new ajouté, readme (hors dossier géré) supprimé
    let v2 = manifest(&blobs, &[("server.cfg", "cfg-v2"), ("resources/a/a.lua", "A2"), ("resources/a/config.lua", "cfgA-v2"), ("resources/new/n.lua", "NEW"), ("resources/same/s.lua", "SAME")], &PROT);
    let hits_before = blobs.hits.load(Ordering::SeqCst);
    let r = run(dir.path(), &blobs, "1.1.0", &v2, Mode::Update).await.unwrap();
    let downloaded = blobs.hits.load(Ordering::SeqCst) - hits_before;

    assert_eq!(downloaded, 2, "seuls a.lua (modifié) et n.lua (nouveau) doivent être téléchargés");
    assert_eq!((r.downloaded_files, r.written, r.deleted, r.kept_protected, r.unchanged), (2, 2, 1, 2, 1));
    assert_eq!(read(dir.path(), "resources/a/a.lua"), "A2");
    assert_eq!(read(dir.path(), "resources/new/n.lua"), "NEW");
    assert_eq!(read(dir.path(), "resources/old/old.lua"), "<absent>", "obsolète dans un dossier géré : supprimé");
    assert!(!dir.path().join("resources/old").exists(), "dossier vidé supprimé");
    assert!(dir.path().join("resources").exists(), "le dossier géré lui-même reste");
    assert_eq!(read(dir.path(), "readme.txt"), "r1", "fichier racine obsolète : jamais supprimé");
    assert_eq!(read(dir.path(), "server.cfg"), "MON-SERVEUR", "protégé : jamais écrasé");
    assert_eq!(read(dir.path(), "resources/a/config.lua"), "MA-CONFIG", "protégé : jamais écrasé");
    assert_eq!(read(dir.path(), "resources/mon-script/x.lua"), "PERSO", "fichier utilisateur dans dossier géré : intact");
    assert_eq!(read(dir.path(), "notes-perso.txt"), "PERSO");
    assert_eq!(state::load(dir.path()).unwrap().unwrap().version, "1.1.0");
    no_leftovers(dir.path());
}

#[tokio::test]
async fn up_to_date_install_does_nothing() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let m = manifest(&blobs, &[("resources/a.lua", "A")], &[]);
    run(dir.path(), &blobs, "1.0.0", &m, Mode::Update).await.unwrap();
    let hits = blobs.hits.load(Ordering::SeqCst);
    let r = run(dir.path(), &blobs, "1.0.0", &m, Mode::Update).await.unwrap();
    assert_eq!((r.written, r.deleted, r.downloaded_files, r.unchanged), (0, 0, 0, 1));
    assert_eq!(blobs.hits.load(Ordering::SeqCst), hits);
}

#[tokio::test]
async fn adopts_existing_identical_files_without_downloading() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("resources")).unwrap();
    std::fs::write(dir.path().join("resources/a.lua"), "A").unwrap();
    let m = manifest(&blobs, &[("resources/a.lua", "A"), ("resources/b.lua", "B")], &[]);
    let r = run(dir.path(), &blobs, "1.0.0", &m, Mode::Update).await.unwrap();
    assert_eq!((r.downloaded_files, r.unchanged), (1, 1));
}

#[tokio::test]
async fn downgrade_restores_previous_files_and_removes_new_ones() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let v1 = manifest(&blobs, &[("resources/a.lua", "A1"), ("resources/gone.lua", "G")], &[]);
    let v2 = manifest(&blobs, &[("resources/a.lua", "A2"), ("resources/added.lua", "ADD")], &[]);
    run(dir.path(), &blobs, "1.0.0", &v1, Mode::Update).await.unwrap();
    run(dir.path(), &blobs, "1.1.0", &v2, Mode::Update).await.unwrap();
    assert_eq!(read(dir.path(), "resources/gone.lua"), "<absent>");
    // rollback côté serveur : la version courante redevient 1.0.0
    run(dir.path(), &blobs, "1.0.0", &v1, Mode::Update).await.unwrap();
    assert_eq!(read(dir.path(), "resources/a.lua"), "A1");
    assert_eq!(read(dir.path(), "resources/gone.lua"), "G");
    assert_eq!(read(dir.path(), "resources/added.lua"), "<absent>");
    assert_eq!(state::load(dir.path()).unwrap().unwrap().version, "1.0.0");
}

#[tokio::test]
async fn corrupted_download_fails_and_leaves_installation_untouched() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let v1 = manifest(&blobs, &[("resources/a.lua", "A1"), ("resources/b.lua", "B1")], &[]);
    run(dir.path(), &blobs, "1.0.0", &v1, Mode::Update).await.unwrap();

    let v2 = manifest(&blobs, &[("resources/a.lua", "A2"), ("resources/b.lua", "B2")], &[]);
    *blobs.corrupt.lock().unwrap() = Some(v2.files[1].sha256.clone()); // le serveur sert un b.lua altéré
    let err = run(dir.path(), &blobs, "1.1.0", &v2, Mode::Update).await.unwrap_err();
    assert!(matches!(err, Error::Integrity(_)), "{err:?}");
    assert_eq!(read(dir.path(), "resources/a.lua"), "A1", "aucune modification partielle");
    assert_eq!(read(dir.path(), "resources/b.lua"), "B1");
    assert_eq!(state::load(dir.path()).unwrap().unwrap().version, "1.0.0");
    no_leftovers(dir.path());

    // le serveur est réparé : la mise à jour passe
    *blobs.corrupt.lock().unwrap() = None;
    run(dir.path(), &blobs, "1.1.0", &v2, Mode::Update).await.unwrap();
    assert_eq!(read(dir.path(), "resources/b.lua"), "B2");
}

#[tokio::test]
async fn failure_during_commit_rolls_back_everything() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let v1 = manifest(&blobs, &[("resources/a.lua", "A1"), ("resources/old.lua", "OLD")], &[]);
    run(dir.path(), &blobs, "1.0.0", &v1, Mode::Update).await.unwrap();

    // « resources/zz » est un FICHIER chez l'utilisateur : impossible d'y créer resources/zz/n.lua
    std::fs::write(dir.path().join("resources/zz"), "je suis un fichier").unwrap();
    let v2 = manifest(&blobs, &[("resources/a.lua", "A2"), ("resources/zz/n.lua", "N")], &[]);
    let err = run(dir.path(), &blobs, "1.1.0", &v2, Mode::Update).await.unwrap_err();
    assert!(matches!(err, Error::Io { .. }), "{err:?}");
    assert_eq!(read(dir.path(), "resources/a.lua"), "A1", "a.lua déjà remplacé → restauré");
    assert_eq!(read(dir.path(), "resources/old.lua"), "OLD", "suppression annulée");
    assert_eq!(read(dir.path(), "resources/zz"), "je suis un fichier");
    assert_eq!(state::load(dir.path()).unwrap().unwrap().version, "1.0.0");
    no_leftovers(dir.path());
}

#[tokio::test]
async fn repair_restores_corrupted_and_missing_files_but_not_protected() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let m = manifest(&blobs, &[("server.cfg", "cfg"), ("resources/a.lua", "A"), ("resources/b.lua", "B"), ("resources/c.lua", "C")], &["server.cfg"]);
    run(dir.path(), &blobs, "1.0.0", &m, Mode::Update).await.unwrap();

    std::fs::write(dir.path().join("resources/a.lua"), "CORROMPU").unwrap(); // même taille que "A"? non → taille différente
    std::fs::write(dir.path().join("resources/b.lua"), "X").unwrap(); // même taille que "B", contenu différent
    std::fs::remove_file(dir.path().join("resources/c.lua")).unwrap();
    std::fs::write(dir.path().join("server.cfg"), "perso").unwrap();

    // une mise à jour « rapide » ne voit pas la corruption de même taille…
    let quick = run(dir.path(), &blobs, "1.0.0", &m, Mode::Update).await.unwrap();
    assert_eq!(quick.written, 2, "a.lua (taille) + c.lua (absent)");
    assert_eq!(read(dir.path(), "resources/b.lua"), "X");
    // …la réparation, si
    let rep = run(dir.path(), &blobs, "1.0.0", &m, Mode::Repair).await.unwrap();
    assert_eq!(rep.written, 1);
    assert_eq!(read(dir.path(), "resources/b.lua"), "B");
    assert_eq!(read(dir.path(), "resources/a.lua"), "A");
    assert_eq!(read(dir.path(), "server.cfg"), "perso");
}

#[tokio::test]
async fn identical_files_are_downloaded_once() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let m = manifest(&blobs, &[("resources/a.lua", "SAME"), ("resources/b.lua", "SAME"), ("resources/c.lua", "SAME")], &[]);
    let r = run(dir.path(), &blobs, "1.0.0", &m, Mode::Update).await.unwrap();
    assert_eq!((r.written, r.downloaded_files), (3, 1));
    assert_eq!(blobs.hits.load(Ordering::SeqCst), 1);
    assert_eq!(read(dir.path(), "resources/c.lua"), "SAME");
}

#[tokio::test]
async fn malicious_manifest_paths_are_rejected_before_any_write() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    for evil in ["../evil.lua", "/abs.lua", "C:/win.lua", "a\\b.lua", "resources/../../x", ".fbm/state.json", "resources/nul.txt", "a//b"] {
        let m = manifest(&blobs, &[("resources/ok.lua", "ok"), (evil, "pwn")], &[]);
        let err = run(dir.path(), &blobs, "6.6.6", &m, Mode::Update).await.unwrap_err();
        assert!(matches!(err, Error::UnsafePath(_)), "{evil}: {err:?}");
    }
    assert!(!dir.path().join("resources/ok.lua").exists());
    assert!(state::load(dir.path()).unwrap().is_none());
}

#[tokio::test]
async fn rejects_invalid_hash_and_duplicate_paths() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let mut m = manifest(&blobs, &[("resources/a.lua", "A")], &[]);
    m.files[0].sha256 = "xyz".into();
    assert!(matches!(run(dir.path(), &blobs, "1", &m, Mode::Update).await, Err(Error::Integrity(_))));
    let mut d = manifest(&blobs, &[("resources/a.lua", "A")], &[]);
    d.files.push(ManifestFile { path: "Resources/A.lua".into(), ..d.files[0].clone() });
    assert!(matches!(run(dir.path(), &blobs, "1", &d, Mode::Update).await, Err(Error::Integrity(_))));
}

#[tokio::test]
async fn cancellation_stops_and_cleans_up() {
    let blobs = Blobs::start();
    let dir = tempfile::tempdir().unwrap();
    let m = manifest(&blobs, &[("resources/a.lua", "A"), ("resources/b.lua", "B")], &[]);
    let cancel = Cancel::new();
    cancel.cancel();
    let err = updater::sync(dir.path(), "1.0.0", "STABLE", &m, &blobs, &http_client(), Mode::Update, &Options::default(), &Tracker::silent(), &cancel).await.unwrap_err();
    assert!(matches!(err, Error::Cancelled));
    assert!(!dir.path().join("resources").exists());
}

#[tokio::test]
async fn recover_rolls_back_an_interrupted_commit() {
    // Simule un crash : journal « committing », a.lua déjà remplacé, sauvegarde présente.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("resources")).unwrap();
    std::fs::create_dir_all(root.join(".fbm/backup/t1/resources")).unwrap();
    std::fs::write(root.join("resources/a.lua"), "NOUVEAU-A-MOITIE").unwrap();
    std::fs::write(root.join("resources/new.lua"), "NEW").unwrap();
    std::fs::write(root.join(".fbm/backup/t1/resources/a.lua"), "A-ORIGINAL").unwrap();
    std::fs::write(root.join(".fbm/backup/t1/resources/deleted.lua"), "D-ORIGINAL").unwrap();
    std::fs::write(
        root.join(".fbm/txn.json"),
        r#"{"id":"t1","committing":true,"ops":[
            {"path":"resources/a.lua","write":true,"had_original":true},
            {"path":"resources/new.lua","write":true,"had_original":false},
            {"path":"resources/deleted.lua","write":false,"had_original":true}]}"#,
    )
    .unwrap();
    assert!(updater::recover(root).unwrap());
    assert_eq!(read(root, "resources/a.lua"), "A-ORIGINAL");
    assert_eq!(read(root, "resources/new.lua"), "<absent>");
    assert_eq!(read(root, "resources/deleted.lua"), "D-ORIGINAL");
    no_leftovers(root);
    assert!(!updater::recover(root).unwrap());
}

#[tokio::test]
async fn expired_links_are_refreshed() {
    // Le premier lien fourni répond 403 (expiré) ; le moteur doit en redemander un nouveau et réussir.
    struct Flaky {
        inner: Blobs,
        expired_base: String,
        calls: AtomicUsize,
    }
    impl Source for Flaky {
        async fn blob_urls(&self, v: &str, h: &[String]) -> Result<HashMap<String, String>> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                return Ok(h.iter().map(|x| (x.clone(), format!("{}/{x}", self.expired_base))).collect());
            }
            self.inner.blob_urls(v, h).await
        }
    }
    let forbidden = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let fport = forbidden.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for r in forbidden.incoming_requests() {
            let _ = r.respond(tiny_http::Response::from_string("expired").with_status_code(403));
        }
    });
    let blobs = Blobs::start();
    let m = manifest(&blobs, &[("resources/a.lua", "A")], &[]);
    let flaky = Flaky { inner: blobs, expired_base: format!("http://127.0.0.1:{fport}"), calls: AtomicUsize::new(0) };
    let dir = tempfile::tempdir().unwrap();
    let r = updater::sync(dir.path(), "1.0.0", "STABLE", &m, &flaky, &http_client(), Mode::Update, &Options::default(), &Tracker::silent(), &Cancel::new())
        .await
        .unwrap();
    assert_eq!(r.written, 1);
    assert_eq!(read(dir.path(), "resources/a.lua"), "A");
    assert_eq!(flaky.calls.load(Ordering::SeqCst), 2, "un lien renouvelé a été demandé");
    no_leftovers(dir.path());
}

#[test]
fn glob_matches_like_the_server() {
    let cases: [(&str, &str, bool); 12] = [
        ("server.cfg", "server.cfg", true),
        ("server.cfg", "SERVER.CFG", true),
        ("**/config.lua", "resources/x/config.lua", true),
        ("**/config.lua", "config.lua", true),
        ("txData/**", "txData/a/b.json", true),
        ("**/*.local.*", "resources/x/a.local.json", true),
        ("**/config.lua", "resources/x/client.lua", false),
        ("server.cfg", "resources/server.cfg.bak", false),
        ("a+b(1).lua", "a+b(1).lua", true),
        ("a+b(1).lua", "aab(1).lua", false),
        ("res?/x", "res1/x", true),
        ("res?/x", "res1/y/x", false),
    ];
    for (g, p, want) in cases {
        assert_eq!(glob_to_regex(g).is_match(p), want, "{g} vs {p}");
    }
}

#[test]
fn path_validation_table() {
    for ok in ["resources/a/fxmanifest.lua", "server.cfg", "[core]/x/y.lua", "é/ü.txt"] {
        assert!(validate_rel(ok).is_ok(), "{ok}");
    }
    for bad in ["../x", "/x", "C:/x", "c:x", "a\\b", "a//b", "./a", "a/./b", "CON", "a/nul.txt", "d/f.", "d /f", "a/b:s", ".fbm/x", "a/\u{1}b", ""] {
        assert!(validate_rel(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn manifest_digest_matches_the_typescript_server() {
    // Vecteur calculé par web/src/lib/manifest.ts (manifestDigest) sur le même manifeste.
    let m = Manifest {
        files: vec![
            ManifestFile { path: "resources/é/a.lua".into(), sha256: "a".repeat(64), size: 12 },
            ManifestFile { path: "server.cfg".into(), sha256: "b".repeat(64), size: 0 },
        ],
        managed_dirs: vec!["resources".into()],
        protected: vec!["server.cfg".into(), "**/config.lua".into()],
    };
    assert_eq!(m.digest(), "024099ced154d9d07a286932abd62ca61cdc8d047fbe2d96a7492817f66f76d6");
}
