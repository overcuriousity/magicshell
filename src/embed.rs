use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use serde_json::Value;
use url::Url;

use crate::error::AppError;
use crate::kit::config::Secret;

#[derive(Debug, Clone)]
pub struct Embedding {
    client: reqwest::Client,
    url: String,
    key: Option<Secret>,
    model: String,
    prefix: String,
    max_reply_bytes: usize,
}

const MAX_REPLY_BYTES: usize = 1024 * 1024;

fn upstream_error(sentence: &str) -> AppError {
    AppError::Upstream(sentence.to_owned())
}

fn bad_reply() -> AppError {
    upstream_error("The embedding endpoint sent an answer this app does not understand.")
}

fn transport_error(e: &reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::UpstreamTimeout
    } else {
        upstream_error("The embedding endpoint cannot be reached. Try again later.")
    }
}

fn status_error(status: StatusCode) -> AppError {
    match status.as_u16() {
        400 | 422 | 500 => AppError::Invalid("The embedding endpoint refused these texts.".into()),
        413 => AppError::TooLarge,
        401 | 403 => upstream_error("The embedding endpoint refused the key. Check the server configuration."),
        404 => upstream_error("The embedding endpoint does not know this model. Check the server configuration."),
        504 => AppError::UpstreamTimeout,
        code => AppError::Upstream(format!("The embedding endpoint answered with an error ({code}). Try again later.")),
    }
}

async fn read_capped(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| transport_error(&e))? {
        if bytes.len() + chunk.len() > max {
            return Err(upstream_error(
                "The embedding endpoint sent an answer that is too large. Check the server configuration.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_reply(bytes: &[u8], expected: usize) -> Result<Vec<Vec<f64>>, AppError> {
    let body: Value = serde_json::from_slice(bytes).map_err(|_| bad_reply())?;
    let data = body["data"].as_array().ok_or_else(bad_reply)?;
    if data.len() != expected {
        return Err(bad_reply());
    }
    let mut vectors = Vec::with_capacity(data.len());
    let mut dimensions = None;
    for item in data {
        let entries = item["embedding"].as_array().ok_or_else(bad_reply)?;
        if entries.is_empty() || dimensions.is_some_and(|size| size != entries.len()) {
            return Err(bad_reply());
        }
        dimensions = Some(entries.len());
        let mut vector = Vec::with_capacity(entries.len());
        for entry in entries {
            let number = entry.as_f64().filter(|number| number.is_finite()).ok_or_else(bad_reply)?;
            vector.push(number);
        }
        vectors.push(vector);
    }
    Ok(vectors)
}

impl Embedding {
    pub fn new(
        endpoint: Url,
        key: Option<Secret>,
        model: String,
        prefix: String,
        timeout: Duration,
    ) -> Result<Self, AppError> {
        let client =
            reqwest::Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none()).build().map_err(
                |_| {
                    upstream_error("The embedding endpoint client could not be set up. Check the server configuration.")
                },
            )?;
        let url = format!("{}/embeddings", endpoint.as_str().trim_end_matches('/'));
        Ok(Self { client, url, key, model, prefix, max_reply_bytes: MAX_REPLY_BYTES })
    }

    #[must_use]
    pub fn with_max_reply_bytes(mut self, bytes: usize) -> Self {
        self.max_reply_bytes = bytes;
        self
    }

    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f64>>, AppError> {
        let input: Vec<String> = texts.iter().map(|text| format!("{}{text}", self.prefix)).collect();
        let body = serde_json::json!({"model": self.model, "input": input});
        let mut request = self.client.post(&self.url).header(CONTENT_TYPE, "application/json").body(body.to_string());
        if let Some(key) = &self.key {
            let mut value = HeaderValue::from_str(&format!("Bearer {}", key.expose())).map_err(|_| {
                upstream_error("The embedding endpoint key is not usable. Check the server configuration.")
            })?;
            value.set_sensitive(true);
            request = request.header(AUTHORIZATION, value);
        }
        let response = request.send().await.map_err(|e| transport_error(&e))?;
        let status = response.status();
        let bytes = read_capped(response, self.max_reply_bytes).await?;
        if !status.is_success() {
            return Err(status_error(status));
        }
        parse_reply(&bytes, texts.len())
    }
}
