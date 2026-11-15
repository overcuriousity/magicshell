#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use support::{FakeReply, TestApp, add_user, fake_upstream, post_json, sign_in, spawn_against};

const PASSWORD: &str = "a long enough password";

async fn open_app(replies: Vec<FakeReply>, extra: &str) -> (TestApp, support::FakeUpstream) {
    let fake = fake_upstream(replies).await;
    let toml = format!("{}embedding_model = \"e\"\n{extra}", support::OPEN);
    let app = spawn_against(&toml, &fake).await;
    (app, fake)
}

#[tokio::test]
async fn embed_route_is_absent_without_embedding_model() {
    let app = support::spawn(support::OPEN).await;
    let res = post_json(&app, "/api/embed", &serde_json::json!({"texts":["q"]}), None).await;
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn signed_out_accounts_callers_cannot_embed() {
    let fake = fake_upstream(vec![]).await;
    let toml = format!("{}embedding_model = \"e\"\n", support::ACCOUNTS);
    let app = support::spawn_against(&toml, &fake).await;
    let res = post_json(&app, "/api/embed", &serde_json::json!({"texts":["q"]}), None).await;
    assert_eq!(res.status(), 401);
    assert!(fake.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_open_request_returns_one_vector_per_input_in_order() {
    let (app, fake) =
        open_app(vec![FakeReply::ok(r#"{"data":[{"embedding":[1.25,0.0]},{"embedding":[0.0,-2.5]}]}"#)], "").await;
    let res = post_json(&app, "/api/embed", &json!({"texts":["first","second"]}), None).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body, json!({"vectors":[[1.25,0.0],[0.0,-2.5]]}));
    let seen = fake.requests.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/v1/embeddings");
    let upstream: Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(upstream["input"], json!(["first", "second"]));
}

#[tokio::test]
async fn a_signed_in_request_returns_vectors() {
    let fake = fake_upstream(vec![FakeReply::ok(r#"{"data":[{"embedding":[0.5,1.0]}]}"#)]).await;
    let toml = format!("{}embedding_model = \"e\"\n", support::ACCOUNTS);
    let app = spawn_against(&toml, &fake).await;
    add_user(&app, "ada", PASSWORD).await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    let res = post_json(&app, "/api/embed", &json!({"texts":["q"]}), Some(&cookie)).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body, json!({"vectors":[[0.5,1.0]]}));
}

#[tokio::test]
async fn invalid_texts_are_refused_before_calling_the_upstream() {
    let (app, fake) = open_app(vec![], "").await;
    let cases = [
        (json!({"texts":[]}), "Send 1 to 64 texts."),
        (json!({"texts":vec!["q";65]}), "Send 1 to 64 texts."),
        (json!({"texts":["q"," \n\t"]}), "Every text must be non-empty."),
        (json!({"texts":"q"}), "The server could not read this request."),
        (json!({"texts":[1]}), "The server could not read this request."),
        (json!({"texts":["q"],"extra":true}), "The server could not read this request."),
    ];
    for (body, sentence) in cases {
        let res = post_json(&app, "/api/embed", &body, None).await;
        assert_eq!(res.status(), 422, "{body}");
        assert_eq!(res.text().await.unwrap(), sentence, "{body}");
    }
    assert!(fake.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_body_over_64_kib_is_refused_before_calling_the_upstream() {
    let (app, fake) = open_app(vec![], "").await;
    let body = json!({"texts":["x".repeat(64 * 1024)]});
    let res = post_json(&app, "/api/embed", &body, None).await;
    assert_eq!(res.status(), 413);
    assert_eq!(res.text().await.unwrap(), "This request is too large. Shorten it and try again.");
    assert!(fake.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_allowance_counts_texts_rather_than_requests() {
    let (app, fake) = open_app(
        vec![
            FakeReply::ok(r#"{"data":[{"embedding":[1.0]},{"embedding":[2.0]}]}"#),
            FakeReply::ok(r#"{"data":[{"embedding":[3.0]}]}"#),
        ],
        "embeds_per_minute = 3\n",
    )
    .await;
    assert_eq!(post_json(&app, "/api/embed", &json!({"texts":["a","b"]}), None).await.status(), 200);
    assert_eq!(post_json(&app, "/api/embed", &json!({"texts":["c"]}), None).await.status(), 200);
    let res = post_json(&app, "/api/embed", &json!({"texts":["d"]}), None).await;
    assert_eq!(res.status(), 429);
    assert_eq!(res.text().await.unwrap(), "Too many questions. Wait a minute and try again.");
    assert_eq!(fake.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn upstream_refusals_are_invalid_while_retryable_errors_keep_their_status() {
    let mut slow = FakeReply::ok(r#"{"data":[{"embedding":[1.0]}]}"#);
    slow.delay = Duration::from_secs(2);
    let (app, _fake) = open_app(
        vec![FakeReply::status(500, "private detail"), FakeReply::status(502, "private detail"), slow],
        "upstream_timeout_secs = 1\n",
    )
    .await;
    let res = post_json(&app, "/api/embed", &json!({"texts":["q"]}), None).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "The embedding endpoint refused these texts.");
    let res = post_json(&app, "/api/embed", &json!({"texts":["q"]}), None).await;
    assert_eq!(res.status(), 502);
    assert_eq!(res.text().await.unwrap(), "The embedding endpoint answered with an error (502). Try again later.");
    let res = post_json(&app, "/api/embed", &json!({"texts":["q"]}), None).await;
    assert_eq!(res.status(), 504);
    assert_eq!(res.text().await.unwrap(), "The model took too long to answer. Try again.");
}

#[tokio::test]
async fn a_foreign_origin_cannot_embed() {
    let (app, fake) = open_app(vec![], "").await;
    let res = app
        .client
        .post(format!("{}/api/embed", app.base))
        .header("origin", "https://evil.example")
        .json(&json!({"texts":["q"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    assert!(fake.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn public_config_exposes_only_similarity_metadata() {
    let (app, fake) = open_app(
        vec![],
        "embedding_endpoint = \"{ENDPOINT}\"\nembedding_api_key = \"embed-secret\"\nembedding_min_similarity = 0.625\n",
    )
    .await;
    let res = app.client.get(format!("{}/api/config", app.base)).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let text = res.text().await.unwrap();
    let body: Value = serde_json::from_str(&text).unwrap();
    let similar = body["similar"].as_object().unwrap();
    assert_eq!(similar.len(), 3);
    assert_eq!(similar["model"], "e");
    assert_eq!(similar["min"], 0.625);
    let id = similar["id"].as_str().unwrap();
    assert_eq!(id.len(), 16);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(!text.contains(fake.url.as_str()));
    assert!(!text.contains("embed-secret"));
}
