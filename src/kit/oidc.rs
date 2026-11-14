//! OIDC sign-in as a backend-for-frontend: the browser only ever holds the session cookie.
//! Adapted from oc-kit `auth/oidc.rs` without JWT bearer verification or resource metadata;
//! the two HTTP clients and the userinfo fallback follow engram's `auth/oidc.rs`.

use std::sync::Arc;
use std::time::Duration;

use openidconnect::core::{CoreAuthenticationFlow, CoreClient, CoreGenderClaim, CoreProviderMetadata};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, EmptyAdditionalClaims, EndpointMaybeSet, EndpointNotSet,
    EndpointSet, IssuerUrl, Nonce, OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    TokenResponse, UserInfoClaims,
};
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;

use crate::kit::OcError;
use crate::kit::config::{Deployment, OidcConfig};
use crate::kit::identity::users::usable_name;

type Client =
    CoreClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointMaybeSet, EndpointMaybeSet>;

const TIMEOUT: Duration = Duration::from_secs(10);

pub struct Oidc {
    cfg: OidcConfig,
    redirect: RedirectUrl,
    /// Follows redirects: Nextcloud's nginx recipe answers the bare `.well-known` path with a 301.
    discovery_http: openidconnect::reqwest::Client,
    /// Follows none: on 307/308 reqwest would replay the client secret, the code or the access token.
    http: openidconnect::reqwest::Client,
    /// Filled on the first successful discovery; a failure is not kept.
    client: OnceCell<Client>,
}

/// What the callback needs from the start, kept in the session in between.
#[derive(Serialize, Deserialize)]
pub struct Pending {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
    pub next: String,
}

/// Who signed in: the account is matched on `(issuer, subject)`; `name` is only for a new one.
pub struct Identity {
    pub issuer: String,
    pub subject: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInError {
    Failed,
    Unreachable,
    NoAccount,
}

impl SignInError {
    /// The code the sign-in page maps to its sentence.
    pub fn code(self) -> &'static str {
        match self {
            Self::Failed => "failed",
            Self::Unreachable => "unreachable",
            Self::NoAccount => "no-account",
        }
    }
}

fn http_client(redirects: openidconnect::reqwest::redirect::Policy) -> Result<openidconnect::reqwest::Client, OcError> {
    openidconnect::reqwest::ClientBuilder::new().redirect(redirects).timeout(TIMEOUT).build().map_err(OcError::internal)
}

impl Oidc {
    pub fn new(cfg: &OidcConfig, dep: &Deployment) -> Result<Arc<Self>, OcError> {
        use openidconnect::reqwest::redirect::Policy;
        Ok(Arc::new(Self {
            cfg: cfg.clone(),
            redirect: RedirectUrl::new(format!("{}/auth/oidc/callback", dep.origin)).map_err(OcError::internal)?,
            discovery_http: http_client(Policy::limited(5))?,
            http: http_client(Policy::none())?,
            client: OnceCell::new(),
        }))
    }

    pub fn auto_provision(&self) -> bool {
        self.cfg.auto_provision
    }

    pub fn label(&self) -> &str {
        &self.cfg.display_name
    }

    /// Discovery is lazy, so the app starts even while the provider is unreachable.
    async fn client(&self) -> Result<&Client, SignInError> {
        self.client
            .get_or_try_init(|| async {
                let issuer = IssuerUrl::new(self.cfg.issuer.clone()).map_err(|e| {
                    tracing::warn!(error = %e, "OIDC issuer is not a URL");
                    SignInError::Unreachable
                })?;
                let meta = CoreProviderMetadata::discover_async(issuer, &self.discovery_http).await.map_err(|e| {
                    tracing::warn!(error = %e, "OIDC discovery failed");
                    SignInError::Unreachable
                })?;
                Ok(CoreClient::from_provider_metadata(
                    meta,
                    ClientId::new(self.cfg.client_id.clone()),
                    Some(ClientSecret::new(self.cfg.client_secret.expose().to_owned())),
                )
                .set_redirect_uri(self.redirect.clone()))
            })
            .await
    }

    /// The provider URL to send the browser to, and what to keep for the callback (`next` left empty).
    pub async fn authorize(&self) -> Result<(String, Pending), SignInError> {
        let client = self.client().await?;
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let mut req =
            client.authorize_url(CoreAuthenticationFlow::AuthorizationCode, CsrfToken::new_random, Nonce::new_random);
        // The crate adds `openid` itself.
        for s in self.cfg.scopes.iter().filter(|s| *s != "openid") {
            req = req.add_scope(Scope::new(s.clone()));
        }
        let (url, state, nonce) = req.set_pkce_challenge(challenge).url();
        let pending = Pending {
            state: state.secret().clone(),
            nonce: nonce.secret().clone(),
            verifier: verifier.secret().clone(),
            next: String::new(),
        };
        Ok((url.to_string(), pending))
    }

    /// Exchanges the code and verifies the ID token against `pending`.
    pub async fn finish(&self, pending: &Pending, code: &str) -> Result<Identity, SignInError> {
        let client = self.client().await.map_err(|_| SignInError::Failed)?;
        let exchange = client.exchange_code(AuthorizationCode::new(code.to_owned())).map_err(|e| {
            tracing::warn!(error = %e, "OIDC provider has no token endpoint");
            SignInError::Failed
        })?;
        let token = exchange
            .set_pkce_verifier(PkceCodeVerifier::new(pending.verifier.clone()))
            .request_async(&self.http)
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, "OIDC code exchange failed");
                SignInError::Failed
            })?;
        let Some(id_token) = token.id_token() else {
            tracing::warn!("OIDC token response has no ID token");
            return Err(SignInError::Failed);
        };
        // Signature, issuer, audience, expiry and nonce.
        let claims = id_token.claims(&client.id_token_verifier(), &Nonce::new(pending.nonce.clone())).map_err(|e| {
            tracing::warn!(error = %e, "ID token rejected");
            SignInError::Failed
        })?;
        let subject = claims.subject().as_str().to_owned();
        let mut name = claims.preferred_username().map(|u| u.as_str().to_owned()).filter(|n| usable_name(n));
        if name.is_none() {
            // Some providers (Nextcloud among them) leave claims to userinfo. Best effort: the
            // signed ID token already vouches for the subject.
            name = self.userinfo_name(client, token.access_token().clone(), claims.subject().clone()).await;
        }
        let name = match name {
            Some(n) => n,
            None if usable_name(&subject) => subject.clone(),
            None => {
                tracing::warn!("OIDC subject cannot name an account");
                return Err(SignInError::Failed);
            }
        };
        Ok(Identity { issuer: claims.issuer().as_str().to_owned(), subject, name })
    }

    async fn userinfo_name(
        &self,
        client: &Client,
        access_token: openidconnect::AccessToken,
        subject: openidconnect::SubjectIdentifier,
    ) -> Option<String> {
        let req = match client.user_info(access_token, Some(subject)) {
            Ok(req) => req,
            Err(e) => {
                tracing::warn!(error = %e, "OIDC provider has no userinfo endpoint");
                return None;
            }
        };
        let info: UserInfoClaims<EmptyAdditionalClaims, CoreGenderClaim> = match req.request_async(&self.http).await {
            Ok(info) => info,
            Err(e) => {
                tracing::warn!(error = %e, "OIDC userinfo request failed");
                return None;
            }
        };
        info.preferred_username().map(|u| u.as_str().to_owned()).filter(|n| usable_name(n))
    }
}
