use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub managed_dirs: Vec<String>,
    #[serde(default)]
    pub protected: Vec<String>,
}

impl Manifest {
    /// Empreinte canonique, identique à `manifestDigest` côté serveur (JSON compact, ordre des clés fixe).
    pub fn digest(&self) -> String {
        let files: Vec<serde_json::Value> = self.files.iter().map(|f| serde_json::json!([f.path, f.sha256, f.size])).collect();
        let canonical = serde_json::json!({ "files": files, "managedDirs": self.managed_dirs, "protected": self.protected });
        hex::encode(Sha256::digest(serde_json::to_string(&canonical).expect("json").as_bytes()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

/// Réponse de `GET /api/launcher/latest`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVersion {
    pub version: String,
    pub channel: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    pub total_size: u64,
    pub file_count: u64,
    pub manifest_sha256: String,
    #[serde(default)]
    pub changes: Vec<Change>,
    pub manifest: Manifest,
}

pub fn is_valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
