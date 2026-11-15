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
    max_reply_bytes: usize,
}

/// System One replies are a few KB; a longer body is not read to its end. A server sets its own
/// with [`Upstream::with_max_reply_bytes`].
const MAX_REPLY_BYTES: usize = 1024 * 1024;

fn upstream_error(sentence: &str) -> AppError {
    AppError::Upstream(sentence.to_owned())
}

/// Too slow: our own timeout, or a 504 from a proxy in front of the model.
fn timeout_error(pictures: bool) -> AppError {
    if pictures { AppError::PicturesTimeout } else { AppError::UpstreamTimeout }
}

fn transport_error(e: &reqwest::Error, pictures: bool) -> AppError {
    if e.is_timeout() {
        timeout_error(pictures)
    } else {
        upstream_error("The model endpoint cannot be reached. Try again later.")
    }
}

fn status_error(status: StatusCode, pictures: bool) -> AppError {
    match status.as_u16() {
        401 | 403 => upstream_error("The model endpoint refused the key. Check the server configuration."),
        404 => upstream_error("The model endpoint does not know this model. Check the server configuration."),
        501 => upstream_error("This model is not a decision model. Check the server configuration."),
        504 => timeout_error(pictures),
        code if pictures => AppError::Upstream(format!(
            "The model endpoint answered with an error ({code}). It may not be able to read pictures."
        )),
        code => AppError::Upstream(format!("The model endpoint answered with an error ({code}). Try again later.")),
    }
}

/// The longest refusal shown, in characters.
const MAX_REFUSAL: usize = 300;

/// What the endpoint says is wrong with a run it refused: `{"error":{"message":…}}`,
/// `{"error":"…"}`, or a body that is not JSON as text. Trimmed and cut to `MAX_REFUSAL`.
fn refusal(bytes: &[u8]) -> Option<String> {
    let text = match serde_json::from_slice::<Value>(bytes) {
        Ok(json) => match &json["error"] {
            Value::String(s) => s.clone(),
            error => error["message"].as_str()?.to_owned(),
        },
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut message: String = text.chars().take(MAX_REFUSAL).collect();
    if text.chars().count() > MAX_REFUSAL {
        message.push('…');
    }
    if !message.ends_with(['.', '!', '?']) {
        message.push('.');
    }
    Some(message)
}

async fn read_capped(mut response: reqwest::Response, max: usize, pictures: bool) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| transport_error(&e, pictures))? {
        if bytes.len() + chunk.len() > max {
            return Err(upstream_error(
                "The model endpoint sent an answer that is too large. Check the server configuration.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

impl Upstream {
    pub fn new(endpoint: Url, key: Option<Secret>, model: String, timeout: Duration) -> Result<Self, AppError> {
        let client =
            reqwest::Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none()).build().map_err(
                |_| upstream_error("The model endpoint client could not be set up. Check the server configuration."),
            )?;
        let url = format!("{}/systemone", endpoint.as_str().trim_end_matches('/'));
        Ok(Self { client, url, key, model, max_reply_bytes: MAX_REPLY_BYTES })
    }

    /// The longest answer read from the endpoint.
    #[must_use]
    pub fn with_max_reply_bytes(mut self, bytes: usize) -> Self {
        self.max_reply_bytes = bytes;
        self
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
        let pictures = !run.images.is_empty();
        let started = Instant::now();
        let response = request.send().await.map_err(|e| transport_error(&e, pictures))?;
        let status = response.status();
        let bytes = read_capped(response, self.max_reply_bytes, pictures).await?;
        let upstream_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        if matches!(status.as_u16(), 400 | 422)
            && let Some(message) = refusal(&bytes)
        {
            return Err(AppError::Upstream(format!("The model endpoint refused this run: {message}")));
        }
        if !status.is_success() {
            return Err(status_error(status, pictures));
        }
        let body: Option<Value> = serde_json::from_slice(&bytes).ok();
        let outcome = parse_response(body.as_ref(), run)?;
        Ok(Reply { outcome, upstream_ms })
    }
}
