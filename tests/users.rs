#![allow(clippy::unwrap_used, clippy::expect_used)]

use magicshell::kit::db;
use magicshell::kit::identity::{password, users};
use time::OffsetDateTime;

// The tables of the app's own migrations.
async fn pool() -> (tempfile::TempDir, sqlx::SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = db::connect(dir.path(), "t.sqlite").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    (dir, pool)
}

#[tokio::test]
async fn a_created_user_can_sign_in_with_their_password() {
    let (_d, pool) = pool().await;
    let now = OffsetDateTime::now_utc();
    let u = users::create(&pool, "Ada", "correct horse", now).await.unwrap();
    let signed_in = users::verify_password(&pool, "ada", "correct horse").await.unwrap().unwrap();
    assert_eq!(signed_in.id, u.id);
    assert_eq!(users::count(&pool).await.unwrap(), 1);
}

#[tokio::test]
async fn a_wrong_password_and_an_unknown_user_both_return_none() {
    let (_d, pool) = pool().await;
    let now = OffsetDateTime::now_utc();
    users::create(&pool, "bob", "pw-123456", now).await.unwrap();
    assert!(users::verify_password(&pool, "bob", "nope").await.unwrap().is_none());
    assert!(users::verify_password(&pool, "nobody", "pw-123456").await.unwrap().is_none());
}

#[tokio::test]
async fn a_changed_password_replaces_the_old_one() {
    let (_d, pool) = pool().await;
    let u = users::create(&pool, "cy", "old-password", OffsetDateTime::now_utc()).await.unwrap();
    users::set_password(&pool, u.id, "new-password").await.unwrap();
    assert!(users::verify_password(&pool, "cy", "old-password").await.unwrap().is_none());
    assert!(users::verify_password(&pool, "cy", "new-password").await.unwrap().is_some());
}

#[tokio::test]
async fn a_username_is_unique_ignoring_case() {
    let (_d, pool) = pool().await;
    let now = OffsetDateTime::now_utc();
    users::create(&pool, "dee", "pw-dee-1", now).await.unwrap();
    let e = users::create(&pool, "DEE", "pw-dee-2", now).await.unwrap_err();
    assert_eq!(e.to_string(), "The username DEE is taken.");
    assert_eq!(users::by_username(&pool, "Dee").await.unwrap().unwrap().username, "dee");
}

#[test]
fn a_hashed_password_verifies_only_against_itself() {
    let h = password::hash("secret-one").unwrap();
    assert!(password::verify("secret-one", &h));
    assert!(!password::verify("secret-two", &h));
    assert_eq!(password::generate(20).len(), 20);
}
