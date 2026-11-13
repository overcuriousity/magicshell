#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode, header};
use axum::response::Html;
use axum::routing::{get, post};
use magicshell::kit::config::OcConfig;
use magicshell::kit::security::{ClientIp, Limits, secure};
use tower::ServiceExt;

const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

fn app(public_url: Option<&str>, peer: [u8; 4]) -> Router {
    let cfg = OcConfig { public_url: public_url.map(|u| u.parse().unwrap()), ..OcConfig::default() };
    let dep = cfg.deployment().unwrap();
    let router = Router::new()
        .route("/", get(|| async { Html("<p>hi</p>") }))
        .route("/write", post(|_b: String| async { "ok" }))
        .route("/ip", get(|ClientIp(ip): ClientIp| async move { ip.to_string() }));
    secure(router, &dep, &cfg.trusted_proxies, Limits { body_bytes: 16, ..Limits::default() })
        .layer(MockConnectInfo(SocketAddr::from((peer, 4000))))
}

fn local() -> Router {
    app(None, [127, 0, 0, 1])
}

fn req(method: &str, uri: &str) -> axum::http::request::Builder {
    Request::builder().method(method).uri(uri).header(header::HOST, "localhost:8080")
}

async fn status(app: Router, r: Request<Body>) -> StatusCode {
    app.oneshot(r).await.unwrap().status()
}

#[tokio::test]
async fn html_responses_carry_the_exact_csp_and_base_headers() {
    let res = local().oneshot(req("GET", "/").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()["content-security-policy"], CSP);
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.headers()["referrer-policy"], "no-referrer");
    assert!(res.headers().get("strict-transport-security").is_none());
}

#[tokio::test]
async fn hsts_is_sent_with_an_https_public_url() {
    let r = Request::get("/").header(header::HOST, "notes.example").body(Body::empty()).unwrap();
    let res = app(Some("https://notes.example"), [127, 0, 0, 1]).oneshot(r).await.unwrap();
    assert!(res.headers().contains_key("strict-transport-security"));
}

#[tokio::test]
async fn a_cross_site_post_with_a_session_cookie_is_rejected() {
    let r = req("POST", "/write")
        .header(header::ORIGIN, "https://evil.example")
        .header(header::COOKIE, "s=1")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(local(), r).await, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_same_origin_post_with_a_session_cookie_passes() {
    let r = req("POST", "/write")
        .header(header::ORIGIN, "http://localhost:8080")
        .header(header::COOKIE, "s=1")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(local(), r).await, StatusCode::OK);
}

#[tokio::test]
async fn a_post_with_neither_origin_nor_fetch_metadata_and_a_cookie_is_rejected() {
    let r = req("POST", "/write").header(header::COOKIE, "s=1").body(Body::empty()).unwrap();
    assert_eq!(status(local(), r).await, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_bearer_post_without_origin_passes_but_not_with_a_foreign_origin() {
    let ok = req("POST", "/write").header(header::AUTHORIZATION, "Bearer x").body(Body::empty()).unwrap();
    assert_eq!(status(local(), ok).await, StatusCode::OK);
    let bad = req("POST", "/write")
        .header(header::AUTHORIZATION, "Bearer x")
        .header(header::ORIGIN, "https://evil.example")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(local(), bad).await, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_foreign_host_header_is_rejected_with_421() {
    let r = Request::get("/").header(header::HOST, "evil.example").body(Body::empty()).unwrap();
    assert_eq!(status(local(), r).await, StatusCode::MISDIRECTED_REQUEST);
}

#[tokio::test]
async fn forwarded_for_is_used_only_from_a_trusted_proxy() {
    let r = || req("GET", "/ip").header("x-forwarded-for", "203.0.113.9").body(Body::empty()).unwrap();
    let body = |res: axum::response::Response| async {
        String::from_utf8(axum::body::to_bytes(res.into_body(), 100).await.unwrap().to_vec()).unwrap()
    };
    assert_eq!(body(local().oneshot(r()).await.unwrap()).await, "203.0.113.9");
    assert_eq!(body(app(None, [10, 0, 0, 5]).oneshot(r()).await.unwrap()).await, "10.0.0.5");
}

#[tokio::test]
async fn bodies_over_the_limit_get_413() {
    let r = req("POST", "/write").header(header::AUTHORIZATION, "Bearer x").body(Body::from(vec![b'a'; 64])).unwrap();
    assert_eq!(status(local(), r).await, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn authenticated_responses_are_no_store() {
    let r = req("GET", "/").header(header::COOKIE, "s=1").body(Body::empty()).unwrap();
    let res = local().oneshot(r).await.unwrap();
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn a_credential_free_post_without_origin_reaches_the_handler() {
    let r = req("POST", "/write").body(Body::empty()).unwrap();
    assert_eq!(status(local(), r).await, StatusCode::OK);
}

#[tokio::test]
async fn a_browser_form_post_with_origin_null_and_same_origin_fetch_metadata_passes() {
    let r = req("POST", "/write")
        .header(header::ORIGIN, "null")
        .header("sec-fetch-site", "same-origin")
        .header(header::COOKIE, "s=1")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(local(), r).await, StatusCode::OK);
}

#[tokio::test]
async fn origin_null_without_fetch_metadata_and_with_a_cookie_is_rejected() {
    let r =
        req("POST", "/write").header(header::ORIGIN, "null").header(header::COOKIE, "s=1").body(Body::empty()).unwrap();
    assert_eq!(status(local(), r).await, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_cross_site_post_is_rejected_even_when_fetch_metadata_is_forged_same_origin() {
    let r = req("POST", "/write")
        .header(header::ORIGIN, "https://evil.example")
        .header("sec-fetch-site", "same-origin")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(local(), r).await, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn rejections_carry_the_base_headers_too() {
    let r = Request::get("/").header(header::HOST, "evil.example").body(Body::empty()).unwrap();
    let res = local().oneshot(r).await.unwrap();
    assert_eq!(res.status(), StatusCode::MISDIRECTED_REQUEST);
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
}

#[tokio::test]
async fn a_forwarded_host_header_cannot_bypass_the_host_check() {
    let r = Request::get("/")
        .header(header::HOST, "evil.example")
        .header("x-forwarded-host", "localhost:8080")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(local(), r).await, StatusCode::MISDIRECTED_REQUEST);
}
