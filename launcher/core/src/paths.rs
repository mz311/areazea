use crate::error::{Error, Result};
use regex::Regex;
use std::path::{Path, PathBuf};

const MAX_PATH: usize = 240;
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7",
    "lpt8", "lpt9",
];

/// Valide un chemin relatif venant d'un manifeste (même règles que le serveur : défense en profondeur).
pub fn validate_rel(rel: &str) -> Result<()> {
    let bad = |why: &str| Err(Error::UnsafePath(format!("{rel:?} ({why})")));
    if rel.is_empty() || rel.len() > MAX_PATH {
        return bad("longueur");
    }
    if rel.contains('\\') || rel.contains('\0') || rel.starts_with('/') {
        return bad("séparateur ou chemin absolu");
    }
    let b = rel.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return bad("lecteur Windows");
    }
    for (i, seg) in rel.split('/').enumerate() {
        if seg.is_empty() || seg == "." || seg == ".." {
            return bad("segment interdit");
        }
        if seg.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) {
            return bad("caractère interdit");
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return bad("point ou espace final");
        }
        let stem = seg.split('.').next().unwrap_or("").to_ascii_lowercase();
        if RESERVED.contains(&stem.as_str()) {
            return bad("nom réservé Windows");
        }
        if i == 0 && seg.eq_ignore_ascii_case(".fbm") {
            return bad("dossier réservé au launcher");
        }
    }
    Ok(())
}

/// `root` + chemin relatif validé.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    validate_rel(rel)?;
    let mut p = root.to_path_buf();
    for seg in rel.split('/') {
        p.push(seg);
    }
    Ok(p)
}

/// Refuse d'écrire à travers un lien symbolique / jonction situé sous `root`.
pub fn ensure_no_symlink_parents(root: &Path, target: &Path) -> Result<()> {
    let mut cur = target.parent();
    while let Some(dir) = cur {
        if dir == root || !dir.starts_with(root) {
            break;
        }
        if let Ok(meta) = std::fs::symlink_metadata(dir) {
            if meta.file_type().is_symlink() {
                return Err(Error::UnsafePath(format!("{} est un lien symbolique", dir.display())));
            }
        }
        cur = dir.parent();
    }
    Ok(())
}

/// Motif glob → regex insensible à la casse (`**` traverse les dossiers). Identique à `globToRegExp` côté serveur.
pub fn glob_to_regex(glob: &str) -> Regex {
    let c: Vec<char> = glob.chars().collect();
    let mut re = String::from("(?i)^");
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '*' => {
                if c.get(i + 1) == Some(&'*') {
                    if c.get(i + 2) == Some(&'/') {
                        re.push_str("(?:.*/)?");
                        i += 2;
                    } else {
                        re.push_str(".*");
                        i += 1;
                    }
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            ch => re.push_str(&regex::escape(&ch.to_string())),
        }
        i += 1;
    }
    re.push('$');
    Regex::new(&re).expect("motif glob invalide")
}

pub struct Globs(Vec<Regex>);

impl Globs {
    pub fn new<'a>(patterns: impl IntoIterator<Item = &'a String>) -> Self {
        Globs(patterns.into_iter().map(|p| glob_to_regex(p)).collect())
    }
    pub fn matches(&self, path: &str) -> bool {
        self.0.iter().any(|r| r.is_match(path))
    }
}

/// Un fichier est « géré » si son premier dossier fait partie des `managed_dirs` du manifeste.
pub fn is_managed(path: &str, managed_dirs: &[String]) -> bool {
    match path.split_once('/') {
        Some((top, _)) => managed_dirs.iter().any(|d| d.eq_ignore_ascii_case(top)),
        None => false,
    }
}

pub fn validate_install_dir(dir: &Path) -> Result<()> {
    if !dir.is_absolute() {
        return Err(Error::Other("Le dossier d'installation doit être un chemin absolu".into()));
    }
    if dir.parent().is_none() {
        return Err(Error::Other("Choisissez un sous-dossier, pas la racine d'un disque".into()));
    }
    if dir.exists() && !dir.is_dir() {
        return Err(Error::Other("Le chemin choisi est un fichier".into()));
    }
    Ok(())
}
