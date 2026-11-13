//! The HTTP call to the System One endpoint.

use std::time::{Duration, Instant};

use reqwest::StatusCode;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::error::AppError;
use crate::kit::config::Secret;
use crate::systemone::{Outcome, Run, parse_response, request_json};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    #[serde(flatten)]
    pub outcome: Outcome,
    pub upstream_ms: u64,
}

#[derive(Debug, Clone)]
pub struct Upstream {
    client: reqwest::Client,
    url: String,
    key: Option<Secret>,
    model: String,
}

fn upstream_error(sentence: &str) -> AppError {
    AppError::Upstream(sentence.to_owned())
}

fn transport_error(e: &reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::UpstreamTimeout
    } else {
        upstream_error("The model endpoint cannot be reached. Try again later.")
    }
}

fn status_error(status: StatusCode) -> AppError {
    match status.as_u16() {
        401 | 403 => upstream_error("The model endpoint refused the key. Check the server configuration."),
        404 => upstream_error("The model endpoint does not know this model. Check the server configuration."),
        501 => upstream_error("This model is not a decision model. Check the server configuration."),
        code => AppError::Upstream(format!("The model endpoint answered with an error ({code}). Try again later.")),
    }
}

impl Upstream {
    pub fn new(endpoint: Url, key: Option<Secret>, model: String, timeout: Duration) -> Result<Self, AppError> {
        let client =
            reqwest::Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none()).build().map_err(
                |_| upstream_error("The model endpoint client could not be set up. Check the server configuration."),
            )?;
        let url = format!("{}/systemone", endpoint.as_str().trim_end_matches('/'));
        Ok(Self { client, url, key, model })
    }

    pub async fn run(&self, run: &Run) -> Result<Reply, AppError> {
        let mut request =
            self.client.post(&self.url).header(CONTENT_TYPE, "application/json").body(request_json(run, &self.model));
        if let Some(key) = &self.key {
            let mut value = HeaderValue::from_str(&format!("Bearer {}", key.expose()))
                .map_err(|_| upstream_error("The model endpoint key is not usable. Check the server configuration."))?;
            value.set_sensitive(true);
            request = request.header(AUTHORIZATION, value);
        }
        let started = Instant::now();
        let response = request.send().await.map_err(|e| transport_error(&e))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|e| transport_error(&e))?;
        let upstream_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        if !status.is_success() {
            return Err(status_error(status));
        }
        let body: Option<Value> = serde_json::from_slice(&bytes).ok();
        let outcome = parse_response(body.as_ref(), run)?;
        Ok(Reply { outcome, upstream_ms })
    }
}
