use crate::error::{Error, Result};
use crate::manifest::{is_valid_sha256, RemoteVersion};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;

/// Fournit des URL de téléchargement temporaires pour des blobs d'une version.
/// Abstraction permettant de tester le moteur sans serveur réel.
pub trait Source: Send + Sync {
    fn blob_urls(&self, version: &str, hashes: &[String]) -> impl Future<Output = Result<HashMap<String, String>>> + Send;
}

#[derive(Clone)]
pub struct ApiClient {
    base: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub name: String,
    pub avatar: String,
    pub role: String,
    pub in_guild: bool,
}

#[derive(Deserialize)]
struct ErrBody {
    error: Option<String>,
    code: Option<String>,
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("FiveMBaseLauncher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .expect("client HTTP")
}

impl ApiClient {
    pub fn new(base: &str, token: &str) -> Self {
        ApiClient { base: base.trim_end_matches('/').to_string(), token: token.to_string(), http: http_client() }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    async fn check(res: reqwest::Response) -> Result<reqwest::Response> {
        if res.status().is_success() {
            return Ok(res);
        }
        let status = res.status().as_u16();
        let body: Option<ErrBody> = res.json().await.ok();
        let (message, code) = match body {
            Some(b) => (b.error.unwrap_or_else(|| format!("Erreur HTTP {status}")), b.code.unwrap_or_else(|| "error".into())),
            None => (format!("Erreur HTTP {status}"), "error".into()),
        };
        Err(Error::Api { status, code, message })
    }

    pub async fn me(&self) -> Result<Me> {
        let res = self.http.get(format!("{}/api/launcher/me", self.base)).bearer_auth(&self.token).send().await?;
        #[derive(Deserialize)]
        struct W {
            user: Me,
        }
        Ok(Self::check(res).await?.json::<W>().await?.user)
    }

    /// Version cible du canal (ou une version précise) avec son manifeste.
    pub async fn latest(&self, channel: &str, version: Option<&str>) -> Result<RemoteVersion> {
        let mut req = self.http.get(format!("{}/api/launcher/latest", self.base)).bearer_auth(&self.token).query(&[("channel", channel)]);
        if let Some(v) = version {
            req = req.query(&[("version", v)]);
        }
        let v: RemoteVersion = Self::check(req.send().await?).await?.json().await?;
        if v.manifest.digest() != v.manifest_sha256 {
            return Err(Error::Integrity("l'empreinte du manifeste reçu ne correspond pas".into()));
        }
        Ok(v)
    }

    /// Signale une opération réussie (statistiques). Les erreurs sont ignorées par l'appelant.
    pub async fn report(&self, version: &str, kind: &str) -> Result<()> {
        let res = self
            .http
            .post(format!("{}/api/launcher/report", self.base))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "version": version, "kind": kind }))
            .send()
            .await?;
        Self::check(res).await.map(|_| ())
    }
}

impl Source for ApiClient {
    async fn blob_urls(&self, version: &str, hashes: &[String]) -> Result<HashMap<String, String>> {
        if hashes.iter().any(|h| !is_valid_sha256(h)) {
            return Err(Error::Integrity("hash invalide dans la demande de téléchargement".into()));
        }
        let res = self
            .http
            .post(format!("{}/api/launcher/blobs", self.base))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "version": version, "hashes": hashes }))
            .send()
            .await?;
        #[derive(Deserialize)]
        struct W {
            urls: HashMap<String, String>,
        }
        Ok(Self::check(res).await?.json::<W>().await?.urls)
    }
}
