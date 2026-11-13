#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

#[tokio::test]
async fn the_server_answers_a_health_check() {
    let app = support::spawn(support::OPEN).await;
    let res = app.client.get(format!("{}/healthz", app.base)).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "ok");
}
