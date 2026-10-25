use crate::error::{IoCtx, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileRecord {
    pub sha256: String,
    pub size: u64,
}

/// État d'installation stocké dans `<dossier>/.fbm/state.json`.
/// Seuls les fichiers listés ici ont été installés par le launcher : ce sont les seuls qu'il peut supprimer.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstallState {
    pub version: String,
    pub channel: String,
    pub installed_at: u64,
    pub files: BTreeMap<String, FileRecord>,
}

pub fn fbm_dir(dir: &Path) -> PathBuf {
    dir.join(".fbm")
}

pub fn state_path(dir: &Path) -> PathBuf {
    fbm_dir(dir).join("state.json")
}

pub fn load(dir: &Path) -> Result<Option<InstallState>> {
    match std::fs::read(state_path(dir)) {
        Ok(b) => match serde_json::from_slice(&b) {
            Ok(s) => Ok(Some(s)),
            // état illisible : on repart d'une installation « adoptée » (les fichiers identiques ne seront pas retéléchargés)
            Err(_) => Ok(None),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(crate::error::Error::io("lecture de l'état", e)),
    }
}

pub fn save(dir: &Path, state: &InstallState) -> Result<()> {
    let path = state_path(dir);
    std::fs::create_dir_all(fbm_dir(dir)).ctx(|| "création de .fbm".into())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state).expect("json")).ctx(|| "écriture de l'état".into())?;
    std::fs::rename(&tmp, &path).ctx(|| "validation de l'état".into())?;
    Ok(())
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
