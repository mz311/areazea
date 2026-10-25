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
