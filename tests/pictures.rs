#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use figment::Figment;
use figment::providers::{Format, Toml};
use magicshell::config::AppConfig;
use magicshell::kit::config::OcConfig;
use magicshell::systemone::{Run, request_json};
use serde_json::{Value, json};
use support::{
    ACCOUNTS, FakeReply, OPEN, TestApp, add_user, fake_upstream, fixture_reply, get_with, post_json, sign_in,
    spawn_against,
};

const PASSWORD: &str = "a long enough password";

/// A JPEG data URL of `bytes` decoded bytes: the magic bytes, then zeros.
fn picture(bytes: usize) -> String {
    let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0];
    data.resize(bytes, 0);
    format!("data:image/jpeg;base64,{}", STANDARD.encode(data))
}

/// The run of `response-noul` with `n` small pictures.
fn run_with(n: usize) -> Value {
    json!({
        "state": "",
        "images": vec![picture(64); n],
        "questions": [{ "key": "wet", "type": "noul", "text": "Is water wet?" }],
    })
}

async fn post_run(app: &TestApp, body: &Value) -> reqwest::Response {
    app.client.post(format!("{}/api/run", app.base)).json(body).send().await.unwrap()
}

async fn answer_to(reply: FakeReply, run: &Value) -> (u16, String) {
    let fake = fake_upstream(vec![reply]).await;
    let app = spawn_against(OPEN, &fake).await;
    let res = post_run(&app, run).await;
    (res.status().as_u16(), res.text().await.unwrap())
}

fn app_config(extra: &str) -> Result<AppConfig, String> {
    let toml = format!("[app]\nendpoint = \"http://127.0.0.1:9/v1\"\nmodel = \"m\"\n{extra}");
    let cfg: OcConfig = Figment::new().merge(Toml::string(&toml)).extract().unwrap();
    AppConfig::from_config(&cfg).map_err(|e| e.to_string())
}

#[tokio::test]
async fn pictures_reach_the_endpoint() {
    let fake = fake_upstream(vec![fixture_reply("response-noul")]).await;
    let app = spawn_against(OPEN, &fake).await;
    let body = run_with(2);
    let res = post_run(&app, &body).await;
    assert_eq!(res.status(), 200);
    let run: Run = serde_json::from_value(body).unwrap();
    let seen = fake.requests.lock().unwrap();
    assert_eq!(seen[0].body, request_json(&run, "test-model"));
    assert!(seen[0].body.contains(r#""state":"","images":["data:image/jpeg;base64,/9j/"#), "{}", &seen[0].body[..120]);
}

#[tokio::test]
async fn with_max_pictures_unset_a_run_with_six_pictures_is_sent() {
    let fake = fake_upstream(vec![fixture_reply("response-noul")]).await;
    let app = spawn_against(OPEN, &fake).await;
    assert_eq!(post_run(&app, &run_with(6)).await.status(), 200);
    assert_eq!(fake.requests.lock().unwrap().len(), 1);
    let body: Value = get_with(&app, "/api/config", None).await.json().await.unwrap();
    assert_eq!(body["pictures"], json!({ "max": null, "edge": 768 }));
}

#[tokio::test]
async fn a_picture_of_500_kb_is_sent() {
    let fake = fake_upstream(vec![fixture_reply("response-noul")]).await;
    let app = spawn_against(OPEN, &fake).await;
    let mut run = run_with(0);
    run["images"] = json!([picture(500 * 1024)]);
    assert_eq!(post_run(&app, &run).await.status(), 200);
}

#[tokio::test]
async fn pictures_over_the_server_limit_are_refused() {
    let fake = fake_upstream(vec![fixture_reply("response-noul")]).await;
    let app = spawn_against(&format!("{OPEN}max_pictures = 2\n"), &fake).await;
    let res = post_run(&app, &run_with(3)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "Use at most 2 pictures.");
    assert_eq!(post_run(&app, &run_with(2)).await.status(), 200);
    assert_eq!(fake.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn one_picture_is_named_in_the_singular() {
    let fake = fake_upstream(vec![]).await;
    let app = spawn_against(&format!("{OPEN}max_pictures = 1\n"), &fake).await;
    assert_eq!(post_run(&app, &run_with(2)).await.text().await.unwrap(), "Use at most 1 picture.");
}

#[tokio::test]
async fn pictures_are_refused_when_turned_off() {
    let fake = fake_upstream(vec![fixture_reply("response-noul")]).await;
    let app = spawn_against(&format!("{OPEN}max_pictures = 0\n"), &fake).await;
    let res = post_run(&app, &run_with(1)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "This server does not take pictures.");
    assert_eq!(post_run(&app, &run_with(0)).await.status(), 200);
}

#[tokio::test]
async fn max_request_mb_bounds_runs_and_what_is_kept_and_sign_in_stays_small() {
    let fake = fake_upstream(vec![fixture_reply("response-noul")]).await;
    let app = spawn_against(&format!("{ACCOUNTS}max_request_mb = 1\n"), &fake).await;
    add_user(&app, "ada", PASSWORD).await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;

    let mut run = run_with(0);
    run["state"] = json!("y".repeat(900 * 1024));
    assert_eq!(post_json(&app, "/api/run", &run, Some(&cookie)).await.status(), 200);

    // Over the old 64 KB but under the setting: refused for its content, never for its size.
    let mid = json!({ "x": "y".repeat(300 * 1024) });
    assert_ne!(post_json(&app, "/api/why", &mid, Some(&cookie)).await.status(), 413);
    for path in ["/api/history/abc", "/api/setups/abc"] {
        let res = app
            .client
            .put(format!("{}{path}", app.base))
            .header("origin", &app.base)
            .header("cookie", &cookie)
            .json(&mid)
            .send()
            .await
            .unwrap();
        assert_ne!(res.status(), 413, "{path}");
    }
    let small = json!({ "x": "y".repeat(65 * 1024) });
    let res = post_json(&app, "/api/auth/password", &small, Some(&cookie)).await;
    assert_eq!(res.status(), 413);
    assert_eq!(res.text().await.unwrap(), "This request is too large. Shorten it and try again.");

    let mut huge = run_with(0);
    huge["state"] = json!("y".repeat(1100 * 1024));
    let res = post_json(&app, "/api/run", &huge, Some(&cookie)).await;
    assert_eq!(res.status(), 413);
    assert_eq!(res.text().await.unwrap(), "This request is too large. Shorten it and try again.");
}

#[tokio::test]
async fn the_config_names_the_request_size() {
    let fake = fake_upstream(vec![]).await;
    let app = spawn_against(OPEN, &fake).await;
    let body: Value = get_with(&app, "/api/config", None).await.json().await.unwrap();
    assert_eq!(body["max_request_bytes"], json!(16 * 1024 * 1024));
}

#[test]
fn max_request_mb_defaults_to_16_and_refuses_0_and_1025() {
    assert_eq!(app_config("").unwrap().max_request_mb, 16);
    assert_eq!(app_config("max_request_mb = 1024\n").unwrap().max_request_mb, 1024);
    for mb in [0, 1025] {
        assert_eq!(
            app_config(&format!("max_request_mb = {mb}\n")).unwrap_err(),
            "Invalid [app] configuration: max_request_mb must be 1 to 1024."
        );
    }
}

#[tokio::test]
async fn why_refuses_pictures() {
    let fake = fake_upstream(vec![fixture_reply("response-noul")]).await;
    let app = spawn_against(ACCOUNTS, &fake).await;
    add_user(&app, "ada", PASSWORD).await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    let res = post_json(&app, "/api/why", &run_with(1), Some(&cookie)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "Why? does not work with pictures.");
    assert!(fake.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_upstream_504_is_a_timeout() {
    let llama_swap = r#"{"src":"llama-swap","error":{"message":"request timeout exceeded","code":"gateway_timeout"}}"#;
    let (status, text) = answer_to(FakeReply::status(504, llama_swap), &run_with(0)).await;
    assert_eq!((status, text.as_str()), (504, "The model took too long to answer. Try again."));
}

#[tokio::test]
async fn picture_runs_get_their_own_error_sentences() {
    let (status, text) = answer_to(FakeReply::status(504, ""), &run_with(1)).await;
    assert_eq!(
        (status, text.as_str()),
        (504, "The model took too long to read the pictures. Try fewer or smaller ones.")
    );

    let (status, text) = answer_to(FakeReply::status(500, "Failed to load image"), &run_with(1)).await;
    assert_eq!(
        (status, text.as_str()),
        (502, "The model endpoint answered with an error (500). It may not be able to read pictures.")
    );

    let (_, text) = answer_to(FakeReply::status(500, ""), &run_with(0)).await;
    assert_eq!(text, "The model endpoint answered with an error (500). Try again later.");
    let (_, text) = answer_to(FakeReply::status(401, ""), &run_with(1)).await;
    assert_eq!(text, "The model endpoint refused the key. Check the server configuration.");
}

#[tokio::test]
async fn a_slow_endpoint_times_out_with_the_picture_sentence() {
    let mut slow = fixture_reply("response-noul");
    slow.delay = std::time::Duration::from_secs(3);
    let fake = fake_upstream(vec![slow]).await;
    let app = spawn_against(&format!("{OPEN}upstream_timeout_secs = 1\n"), &fake).await;
    let res = post_run(&app, &run_with(1)).await;
    assert_eq!(res.status(), 504);
    assert_eq!(res.text().await.unwrap(), "The model took too long to read the pictures. Try fewer or smaller ones.");
}

#[tokio::test]
async fn config_tells_the_page_about_pictures() {
    let fake = fake_upstream(vec![]).await;
    let app = spawn_against(OPEN, &fake).await;
    let body: Value = get_with(&app, "/api/config", None).await.json().await.unwrap();
    assert_eq!(body["pictures"], json!({ "max": null, "edge": 768 }));

    let app = spawn_against(&format!("{OPEN}max_pictures = 2\npicture_max_edge = 1024\n"), &fake).await;
    let body: Value = get_with(&app, "/api/config", None).await.json().await.unwrap();
    assert_eq!(body["pictures"], json!({ "max": 2, "edge": 1024 }));

    let app = spawn_against(&format!("{OPEN}max_pictures = 0\n"), &fake).await;
    let body: Value = get_with(&app, "/api/config", None).await.json().await.unwrap();
    assert_eq!(body["pictures"], Value::Null);
}

#[test]
fn picture_keys_outside_their_range_are_refused() {
    assert!(app_config("").is_ok());
    assert!(app_config("max_pictures = 4\npicture_max_edge = 2048\n").is_ok());
    assert_eq!(app_config("").unwrap().max_pictures, None);
    assert_eq!(app_config("max_pictures = 10\n").unwrap().max_pictures, Some(10));
    for edge in [255, 2049] {
        assert_eq!(
            app_config(&format!("picture_max_edge = {edge}\n")).unwrap_err(),
            "Invalid [app] configuration: picture_max_edge must be 256 to 2048."
        );
    }
}
