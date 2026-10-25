//! Moteur de mise à jour différentielle du launcher.
//!
//! * [`updater::plan`] compare le dossier local au manifeste distant (SHA-256) ;
//! * [`updater::apply`] télécharge uniquement les fichiers nouveaux/modifiés, les vérifie, puis les installe
//!   de façon transactionnelle (sauvegarde + restauration automatique) ;
//! * les fichiers protégés (configuration) ne sont jamais écrasés ni supprimés ;
//! * seuls les fichiers installés par le launcher, dans les dossiers gérés, peuvent être supprimés.

pub mod api;
pub mod error;
pub mod manifest;
pub mod paths;
pub mod progress;
pub mod state;
pub mod updater;

pub use api::{ApiClient, Me, Source};
pub use error::{Error, Result};
pub use manifest::{Manifest, ManifestFile, RemoteVersion};
pub use progress::{Cancel, Phase, Progress, Tracker};
pub use updater::{apply, plan, recover, sync, Mode, Options, Plan, SyncReport};

/// Compare deux numéros de version « semver » simplifiés (`1.2.0`, `v1.2.0-beta.1`) : les parties numériques d'abord,
/// puis une pré-version est inférieure à la version finale.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(v: &str) -> (Vec<u64>, Option<String>) {
        let v = v.trim().trim_start_matches(['v', 'V']);
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p.to_string())),
            None => (v, None),
        };
        let core = core.split('+').next().unwrap_or("");
        (core.split('.').map(|n| n.parse().unwrap_or(0)).collect(), pre)
    }
    let ((na, pa), (nb, pb)) = (parse(a), parse(b));
    let len = na.len().max(nb.len());
    for i in 0..len {
        let (x, y) = (na.get(i).copied().unwrap_or(0), nb.get(i).copied().unwrap_or(0));
        if x != y {
            return x.cmp(&y);
        }
    }
    match (pa, pb) {
        (None, None) => std::cmp::Ordering::Equal,
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => x.cmp(&y),
    }
}

#[cfg(test)]
mod tests {
    use super::compare_versions as c;
    use std::cmp::Ordering::*;

    #[test]
    fn version_ordering() {
        assert_eq!(c("1.0.0", "1.0.0"), Equal);
        assert_eq!(c("1.1.0", "1.0.9"), Greater);
        assert_eq!(c("1.10.0", "1.9.0"), Greater);
        assert_eq!(c("v2.0.0", "1.99.99"), Greater);
        assert_eq!(c("2.0.0-beta.1", "2.0.0"), Less);
        assert_eq!(c("2.0.0-beta.1", "1.9.0"), Greater);
        assert_eq!(c("1.0", "1.0.0"), Equal);
    }
}
