//! The embedded `web/` directory, served from the root.

use axum::http::{HeaderValue, Method, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::kit::OcError;

#[derive(RustEmbed)]
#[folder = "web/"]
#[exclude = "*.test.mjs"]
struct Web;

pub async fn serve(method: Method, uri: Uri) -> Response {
    // An API route that is not mounted (storage in open mode) does not exist, whatever the method.
    if uri.path().starts_with("/api/") {
        return OcError::NotFound.into_response();
    }
    if method != Method::GET && method != Method::HEAD {
        return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = match uri.path().trim_start_matches('/') {
        "" => "index.html",
        p => p,
    };
    let Some(file) = Web::get(path) else {
        return OcError::NotFound.into_response();
    };
    let mime = HeaderValue::from_static(mime_of(path));
    let mut body = file.data.into_owned();
    if path == "sw.js" {
        // The cache name carries the version, so a new release replaces the cached offline page.
        body = String::from_utf8_lossy(&body).replace("__VERSION__", env!("CARGO_PKG_VERSION")).into_bytes();
    }
    ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))], body)
        .into_response()
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
