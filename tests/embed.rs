#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Duration;

use magicshell::embed::Embedding;
use magicshell::error::AppError;
use magicshell::kit::config::Secret;
use support::{FakeReply, fake_upstream};

const BAD_REPLY: &str = "The embedding endpoint sent an answer this app does not understand.";

fn embedding(url: url::Url, key: Option<&str>) -> Embedding {
    Embedding::new(url, key.map(Secret::new), "e".into(), "query: ".into(), Duration::from_secs(5)).unwrap()
}

async fn error_of(reply: FakeReply) -> AppError {
    let fake = fake_upstream(vec![reply]).await;
    embedding(fake.url, None).embed(&["dinner".into(), "urgent".into()]).await.unwrap_err()
}

async fn assert_bad_reply(body: &str) {
    let err = error_of(FakeReply::ok(body)).await;
    assert!(matches!(err, AppError::Upstream(_)));
    assert_eq!(err.status(), axum::http::StatusCode::BAD_GATEWAY);
    assert_eq!(err.to_string(), BAD_REPLY);
}

#[tokio::test]
async fn embeddings_use_the_openai_shape_and_prefix_every_text() {
    let fake =
        fake_upstream(vec![FakeReply::ok(r#"{"data":[{"embedding":[1.0,0.0]},{"embedding":[0.0,1.0]}]}"#)]).await;
    let client = Embedding::new(
        fake.url.clone(),
        Some(Secret::new("embed-secret")),
        "e".into(),
        "query: ".into(),
        Duration::from_secs(5),
    )
    .unwrap();
    let got = client.embed(&["dinner".into(), "urgent".into()]).await.unwrap();
    assert_eq!(got, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
    let seen = fake.requests.lock().unwrap();
    assert_eq!(seen[0].path, "/v1/embeddings");
    assert_eq!(seen[0].authorization.as_deref(), Some("Bearer embed-secret"));
    let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(body, serde_json::json!({"model":"e", "input":["query: dinner", "query: urgent"]}));
}

#[tokio::test]
async fn no_authorization_header_is_sent_without_a_key() {
    let fake = fake_upstream(vec![FakeReply::ok(r#"{"data":[{"embedding":[1.0]}]}"#)]).await;
    embedding(fake.url.clone(), None).embed(&["dinner".into()]).await.unwrap();
    assert_eq!(fake.requests.lock().unwrap()[0].authorization, None);
}

#[tokio::test]
async fn vectors_keep_array_order_and_f64_precision() {
    let fake = fake_upstream(vec![FakeReply::ok(
        r#"{"data":[{"embedding":[1.2345678901234567,-0.0000000000000000001]},{"embedding":[9007199254740992.0,2.5]}]}"#),
    ])
    .await;
    let got = embedding(fake.url, None).embed(&["first".into(), "second".into()]).await.unwrap();
    assert_eq!(got, vec![vec![1.2345678901234567, -0.0000000000000000001], vec![9007199254740992.0, 2.5]]);
}

#[tokio::test]
async fn refused_texts_are_invalid_for_400_422_and_500() {
    for status in [400, 422, 500] {
        let err = error_of(FakeReply::status(status, "private upstream detail")).await;
        assert!(matches!(err, AppError::Invalid(_)));
        assert_eq!(err.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.to_string(), "The embedding endpoint refused these texts.");
    }
}

#[tokio::test]
async fn an_upstream_413_is_too_large() {
    let err = error_of(FakeReply::status(413, "no")).await;
    assert!(matches!(err, AppError::TooLarge));
    assert_eq!(err.status(), axum::http::StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn retryable_statuses_are_bad_gateways() {
    for status in [429, 502, 503] {
        let err = error_of(FakeReply::status(status, "private upstream detail")).await;
        assert!(matches!(err, AppError::Upstream(_)));
        assert_eq!(err.status(), axum::http::StatusCode::BAD_GATEWAY);
        assert_eq!(
            err.to_string(),
            format!("The embedding endpoint answered with an error ({status}). Try again later.")
        );
    }
}

#[tokio::test]
async fn an_upstream_504_is_a_gateway_timeout() {
    let err = error_of(FakeReply::status(504, "no")).await;
    assert!(matches!(err, AppError::UpstreamTimeout));
    assert_eq!(err.status(), axum::http::StatusCode::GATEWAY_TIMEOUT);
}

#[tokio::test]
async fn a_refused_key_names_the_embedding_configuration() {
    for status in [401, 403] {
        let err = error_of(FakeReply::status(status, "no")).await;
        assert!(matches!(err, AppError::Upstream(_)));
        assert_eq!(err.to_string(), "The embedding endpoint refused the key. Check the server configuration.");
    }
}

#[tokio::test]
async fn an_unknown_model_names_the_embedding_configuration() {
    let err = error_of(FakeReply::status(404, "no")).await;
    assert!(matches!(err, AppError::Upstream(_)));
    assert_eq!(err.to_string(), "The embedding endpoint does not know this model. Check the server configuration.");
}

#[tokio::test]
async fn a_closed_port_is_a_retryable_bad_gateway() {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let url: url::Url = format!("http://127.0.0.1:{port}/v1").parse().unwrap();
    let err = embedding(url, None).embed(&["dinner".into()]).await.unwrap_err();
    assert!(matches!(err, AppError::Upstream(_)));
    assert_eq!(err.status(), axum::http::StatusCode::BAD_GATEWAY);
    assert_eq!(err.to_string(), "The embedding endpoint cannot be reached. Try again later.");
}

#[tokio::test]
async fn a_slow_endpoint_times_out() {
    let mut slow = FakeReply::ok(r#"{"data":[{"embedding":[1.0]}]}"#);
    slow.delay = Duration::from_secs(1);
    let fake = fake_upstream(vec![slow]).await;
    let client = Embedding::new(fake.url, None, "e".into(), String::new(), Duration::from_millis(200)).unwrap();
    let err = client.embed(&["dinner".into()]).await.unwrap_err();
    assert!(matches!(err, AppError::UpstreamTimeout));
    assert_eq!(err.status(), axum::http::StatusCode::GATEWAY_TIMEOUT);
}

#[tokio::test]
async fn malformed_json_is_rejected_without_echoing_the_body() {
    assert_bad_reply("not JSON: private upstream detail").await;
}

#[tokio::test]
async fn malformed_reply_shapes_are_rejected() {
    for body in [
        r#"null"#,
        r#"{}"#,
        r#"{"data":{}}"#,
        r#"{"data":[null,null]}"#,
        r#"{"data":[{},{}]}"#,
        r#"{"data":[{"embedding":{}},{"embedding":{}}]}"#,
    ] {
        assert_bad_reply(body).await;
    }
}

#[tokio::test]
async fn missing_vectors_are_rejected() {
    assert_bad_reply(r#"{"data":[{"embedding":[1.0,0.0]}]}"#).await;
}

#[tokio::test]
async fn extra_vectors_are_rejected() {
    assert_bad_reply(r#"{"data":[{"embedding":[1.0,0.0]},{"embedding":[0.0,1.0]},{"embedding":[1.0,1.0]}]}"#).await;
}

#[tokio::test]
async fn unequal_dimensions_are_rejected() {
    assert_bad_reply(r#"{"data":[{"embedding":[1.0,0.0]},{"embedding":[1.0]}]}"#).await;
}

#[tokio::test]
async fn empty_dimensions_are_rejected() {
    assert_bad_reply(r#"{"data":[{"embedding":[]},{"embedding":[]}]}"#).await;
}

#[tokio::test]
async fn non_number_entries_are_rejected() {
    for entry in ["null", r#""1.0""#, "true", "{}", "[]"] {
        let body = format!(r#"{{"data":[{{"embedding":[{entry},0.0]}},{{"embedding":[0.0,1.0]}}]}}"#);
        assert_bad_reply(&body).await;
    }
}

#[tokio::test]
async fn non_finite_entries_are_rejected() {
    assert_bad_reply(r#"{"data":[{"embedding":[1e400,0.0]},{"embedding":[0.0,1.0]}]}"#).await;
}

#[tokio::test]
async fn a_reply_over_the_configured_cap_is_rejected() {
    let fake = fake_upstream(vec![FakeReply::ok(r#"{"data":[{"embedding":[1.0]}]}"#)]).await;
    let err = embedding(fake.url, None).with_max_reply_bytes(8).embed(&["dinner".into()]).await.unwrap_err();
    assert!(matches!(err, AppError::Upstream(_)));
    assert_eq!(
        err.to_string(),
        "The embedding endpoint sent an answer that is too large. Check the server configuration."
    );
}

#[tokio::test]
async fn an_over_cap_refusal_body_does_not_replace_the_refusal() {
    let fake = fake_upstream(vec![FakeReply::status(400, "x".repeat(32))]).await;
    let err = embedding(fake.url, None).with_max_reply_bytes(8).embed(&["dinner".into()]).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
    assert_eq!(err.to_string(), "The embedding endpoint refused these texts.");
}

#[tokio::test]
async fn a_trailing_slash_on_the_endpoint_is_ignored() {
    let fake = fake_upstream(vec![FakeReply::ok(r#"{"data":[{"embedding":[1.0]}]}"#)]).await;
    let url: url::Url = format!("{}/", fake.url).parse().unwrap();
    embedding(url, None).embed(&["dinner".into()]).await.unwrap();
    assert_eq!(fake.requests.lock().unwrap()[0].path, "/v1/embeddings");
}

#[tokio::test]
async fn a_redirect_from_the_endpoint_is_not_followed() {
    let target = fake_upstream(vec![FakeReply::ok(r#"{"data":[{"embedding":[1.0]}]}"#)]).await;
    let location = format!("{}/embeddings", target.url);
    let router = axum::Router::new().fallback(move || {
        let location = location.clone();
        async move { (axum::http::StatusCode::FOUND, [("location", location)], "") }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url: url::Url = format!("http://{}/v1", listener.local_addr().unwrap()).parse().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let err = embedding(url, None).embed(&["dinner".into()]).await.unwrap_err();
    assert_eq!(err.to_string(), "The embedding endpoint answered with an error (302). Try again later.");
    assert!(target.requests.lock().unwrap().is_empty());
}
