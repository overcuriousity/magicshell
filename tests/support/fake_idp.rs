//! A fake OIDC provider on `127.0.0.1:0`, from oc-kit v2026.11.1 `tests/support/fake_idp.rs`,
//! with a userinfo endpoint and the knobs of [`Script`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, jwk::Jwk};
use serde_json::json;

pub const KEY: &[u8] = include_bytes!("../fixtures/test-idp-es256.pem");

/// The client id `sso_toml` configures; the ID token's audience unless `Script.aud` says otherwise.
pub const CLIENT_ID: &str = "magicshell";

/// What the provider answers; tests change it through `Idp.script`.
pub struct Script {
    pub sub: String,
    /// In the ID token.
    pub preferred_username: Option<String>,
    /// In the userinfo answer.
    pub userinfo_username: Option<String>,
    pub userinfo_status: u16,
    /// `None`: the client id.
    pub aud: Option<String>,
    /// `None`: the one the app sent.
    pub nonce: Option<String>,
    pub expired: bool,
    pub token_status: u16,
    /// Every endpoint answers 503.
    pub down: bool,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            sub: "sub-ada".into(),
            preferred_username: Some("ada".into()),
            userinfo_username: None,
            userinfo_status: 200,
            aud: None,
            nonce: None,
            expired: false,
            token_status: 200,
            down: false,
        }
    }
}

#[derive(Clone)]
pub struct Idp {
    pub issuer: String,
    pub script: Arc<Mutex<Script>>,
    /// Issued codes and the nonce of the authorize URL each was issued for.
    codes: Arc<Mutex<HashMap<String, String>>>,
}

impl Idp {
    /// What the provider does when the browser arrives at `authorize`: it records the nonce
    /// and returns the code it would send back to the callback.
    pub fn grant(&self, authorize: &url::Url) -> String {
        let nonce = query(authorize, "nonce").unwrap_or_default();
        let mut codes = self.codes.lock().unwrap();
        let code = format!("code-{}", codes.len() + 1);
        codes.insert(code.clone(), nonce);
        code
    }

    fn id_token(&self, nonce: &str) -> String {
        let s = self.script.lock().unwrap();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let (iat, exp) = if s.expired { (now - 600, now - 300) } else { (now, now + 300) };
        let mut claims = json!({
            "iss": self.issuer,
            "sub": s.sub,
            "aud": s.aud.as_deref().unwrap_or(CLIENT_ID),
            "nonce": s.nonce.as_deref().unwrap_or(nonce),
            "iat": iat,
            "exp": exp,
        });
        if let Some(name) = &s.preferred_username {
            claims["preferred_username"] = json!(name);
        }
        let mut h = Header::new(Algorithm::ES256);
        h.kid = Some("k1".into());
        encode(&h, &claims, &EncodingKey::from_ec_pem(KEY).unwrap()).unwrap()
    }

    fn down(&self) -> bool {
        self.script.lock().unwrap().down
    }
}

pub fn query(url: &url::Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

pub async fn spawn() -> Idp {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let idp = Idp {
        issuer: format!("http://{}", listener.local_addr().unwrap()),
        script: Arc::default(),
        codes: Arc::default(),
    };
    let app = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/jwks", get(jwks))
        .route("/token", post(token))
        .route("/userinfo", get(userinfo))
        .with_state(idp.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    idp
}

fn unavailable() -> Response {
    StatusCode::SERVICE_UNAVAILABLE.into_response()
}

async fn discovery(State(idp): State<Idp>) -> Response {
    if idp.down() {
        return unavailable();
    }
    let i = &idp.issuer;
    Json(json!({
        "issuer": i,
        "authorization_endpoint": format!("{i}/authorize"),
        "token_endpoint": format!("{i}/token"),
        "userinfo_endpoint": format!("{i}/userinfo"),
        "jwks_uri": format!("{i}/jwks"),
        "response_types_supported": ["code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["ES256"],
    }))
    .into_response()
}

async fn jwks(State(idp): State<Idp>) -> Response {
    if idp.down() {
        return unavailable();
    }
    let mut jwk = Jwk::from_encoding_key(&EncodingKey::from_ec_pem(KEY).unwrap(), Algorithm::ES256).unwrap();
    jwk.common.key_id = Some("k1".into());
    Json(json!({ "keys": [jwk] })).into_response()
}

async fn token(State(idp): State<Idp>, Form(f): Form<HashMap<String, String>>) -> Response {
    if idp.down() {
        return unavailable();
    }
    let status = idp.script.lock().unwrap().token_status;
    if status != 200 {
        let code = StatusCode::from_u16(status).unwrap();
        return (code, Json(json!({"error": "invalid_grant"}))).into_response();
    }
    assert!(f.get("code_verifier").is_some_and(|v| !v.is_empty()), "PKCE verifier missing");
    let Some(nonce) = f.get("code").and_then(|c| idp.codes.lock().unwrap().remove(c)) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant"}))).into_response();
    };
    Json(json!({"access_token": "at", "token_type": "Bearer", "expires_in": 300, "id_token": idp.id_token(&nonce)}))
        .into_response()
}

async fn userinfo(State(idp): State<Idp>) -> Response {
    if idp.down() {
        return unavailable();
    }
    let s = idp.script.lock().unwrap();
    if s.userinfo_status != 200 {
        return StatusCode::from_u16(s.userinfo_status).unwrap().into_response();
    }
    let mut body = json!({ "sub": s.sub });
    if let Some(name) = &s.userinfo_username {
        body["preferred_username"] = json!(name);
    }
    Json(body).into_response()
}
