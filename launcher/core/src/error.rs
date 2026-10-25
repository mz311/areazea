use std::io;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("Erreur réseau : {0}")]
    Http(#[from] reqwest::Error),
    /// Réponse d'erreur de l'API (`code` : identifiant stable, ex. `maintenance`, `role_required`).
    #[error("{message}")]
    Api { status: u16, code: String, message: String },
    #[error("Erreur disque ({context}) : {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
    #[error("Intégrité : {0}")]
    Integrity(String),
    #[error("Chemin dangereux refusé : {0}")]
    UnsafePath(String),
    #[error("Opération annulée")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn io(context: impl Into<String>, source: io::Error) -> Self {
        Error::Io { context: context.into(), source }
    }

    /// Message destiné à l'utilisateur final (avec conseils pour les cas fréquents).
    pub fn user_message(&self) -> String {
        match self {
            // 32 = ERROR_SHARING_VIOLATION, 5 = ERROR_ACCESS_DENIED (Windows)
            Error::Io { source, .. } if matches!(source.raw_os_error(), Some(32) | Some(5)) || source.kind() == io::ErrorKind::PermissionDenied => {
                format!("{self}\nUn fichier est probablement utilisé : fermez le serveur FiveM / l'éditeur qui l'utilise puis réessayez.")
            }
            Error::Api { code, .. } if code == "maintenance" => format!("{self} (maintenance en cours)"),
            _ => self.to_string(),
        }
    }

    pub fn code(&self) -> &str {
        match self {
            Error::Api { code, .. } => code,
            Error::Cancelled => "cancelled",
            Error::Integrity(_) => "integrity",
            Error::UnsafePath(_) => "unsafe_path",
            Error::Io { .. } => "io",
            Error::Http(_) => "network",
            Error::Other(_) => "error",
        }
    }
}

pub(crate) trait IoCtx<T> {
    fn ctx(self, context: impl FnOnce() -> String) -> Result<T>;
}

impl<T> IoCtx<T> for std::result::Result<T, io::Error> {
    fn ctx(self, context: impl FnOnce() -> String) -> Result<T> {
        self.map_err(|e| Error::io(context(), e))
    }
}
