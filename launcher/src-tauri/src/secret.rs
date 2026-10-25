//! Stockage du jeton launcher. Windows : Gestionnaire d'informations d'identification (keyring).
//! Autres plateformes (développement uniquement) : fichier dans le dossier de configuration.

use std::path::Path;

#[cfg(windows)]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("FiveM Base Launcher", "launcher-token").map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn load(_dir: &Path) -> Option<String> {
    entry().ok()?.get_password().ok()
}

#[cfg(windows)]
pub fn save(_dir: &Path, token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn clear(_dir: &Path) {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}

#[cfg(not(windows))]
pub fn load(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join("token")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(not(windows))]
pub fn save(dir: &Path, token: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let p = dir.join("token");
    std::fs::write(&p, token).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn clear(dir: &Path) {
    let _ = std::fs::remove_file(dir.join("token"));
}
