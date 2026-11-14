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

async fn oidc(pool: &sqlx::SqlitePool, issuer: &str, subject: &str, name: &str) -> Option<users::User> {
    users::find_or_provision_oidc(pool, issuer, subject, name, true, OffsetDateTime::now_utc()).await.unwrap()
}

async fn identities(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM oidc_identities").fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn a_first_oidc_sign_in_creates_the_account() {
    let (_d, pool) = pool().await;
    let user = oidc(&pool, "https://idp", "sub-1", "ada").await.unwrap();
    assert_eq!(user.username, "ada");
    assert_eq!(users::count(&pool).await.unwrap(), 1);
}

#[tokio::test]
async fn a_second_sign_in_reaches_the_same_account() {
    let (_d, pool) = pool().await;
    let a = oidc(&pool, "https://idp", "sub-1", "ada").await.unwrap();
    let b = oidc(&pool, "https://idp", "sub-1", "someone else").await.unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(b.username, "ada");
    assert_eq!(users::count(&pool).await.unwrap(), 1);
}

#[tokio::test]
async fn two_subjects_never_share_an_account() {
    let (_d, pool) = pool().await;
    let a = oidc(&pool, "https://idp", "sub-1", "ada").await.unwrap();
    let b = oidc(&pool, "https://idp", "sub-2", "ada").await.unwrap();
    assert_ne!(a.id, b.id);
    assert_eq!(b.username, "ada-2");
}

#[tokio::test]
async fn the_same_subject_under_another_issuer_is_another_account() {
    let (_d, pool) = pool().await;
    let a = oidc(&pool, "https://idp", "sub-1", "ada").await.unwrap();
    let b = oidc(&pool, "https://other", "sub-1", "ada").await.unwrap();
    assert_ne!(a.id, b.id);
    assert_eq!(b.username, "ada-2");
}

#[tokio::test]
async fn a_name_clash_with_a_password_account_gets_a_suffix() {
    let (_d, pool) = pool().await;
    let now = OffsetDateTime::now_utc();
    let old = users::create(&pool, "Ada", "correct horse 12", now).await.unwrap();
    let new = oidc(&pool, "https://idp", "sub-1", "ada").await.unwrap();
    assert_ne!(new.id, old.id);
    assert_eq!(new.username, "ada-2");
    assert_eq!(users::verify_password(&pool, "ada", "correct horse 12").await.unwrap().unwrap().id, old.id);
}

#[tokio::test]
async fn without_auto_provision_an_unknown_identity_writes_nothing() {
    let (_d, pool) = pool().await;
    let found = users::find_or_provision_oidc(&pool, "https://idp", "sub-1", "ada", false, OffsetDateTime::now_utc())
        .await
        .unwrap();
    assert!(found.is_none());
    assert_eq!(users::count(&pool).await.unwrap(), 0);
    assert_eq!(identities(&pool).await, 0);
}

#[tokio::test]
async fn an_sso_account_has_no_password() {
    let (_d, pool) = pool().await;
    oidc(&pool, "https://idp", "sub-1", "ada").await.unwrap();
    assert!(users::verify_password(&pool, "ada", "").await.unwrap().is_none());
    assert!(users::verify_password(&pool, "ada", "anything").await.unwrap().is_none());
}

#[test]
fn usable_names() {
    for ok in ["ada", "Ada Lovelace", "ada@cloud.example", "o'neil"] {
        assert!(users::usable_name(ok), "{ok}");
    }
    for bad in ["", &"a".repeat(256), "a\nb", "a\u{0}b"] {
        assert!(!users::usable_name(bad), "{bad:?}");
    }
}

#[tokio::test]
async fn a_password_session_outlives_the_mode_but_a_provider_one_does_not() {
    let (_d, pool) = pool().await;
    let pw = users::create(&pool, "bob", "pw-123456", OffsetDateTime::now_utc()).await.unwrap();
    let sso = oidc(&pool, "https://idp", "sub-1", "ada").await.unwrap();
    let e_pw = users::session_epoch(&pool, pw.id).await.unwrap().unwrap();
    let e_sso = users::session_epoch(&pool, sso.id).await.unwrap().unwrap();
    assert!(users::by_session(&pool, pw.id, e_pw, false).await.unwrap().is_some());
    assert!(users::by_session(&pool, pw.id, e_pw, true).await.unwrap().is_some());
    assert!(users::by_session(&pool, sso.id, e_sso, true).await.unwrap().is_some());
    assert!(users::by_session(&pool, sso.id, e_sso, false).await.unwrap().is_none());
}

#[tokio::test]
async fn removing_a_user_removes_the_identity() {
    let (_d, pool) = pool().await;
    oidc(&pool, "https://idp", "sub-1", "ada").await.unwrap();
    assert_eq!(identities(&pool).await, 1);
    assert!(users::delete_by_username(&pool, "ada").await.unwrap());
    assert_eq!(identities(&pool).await, 0);
}

#[tokio::test]
async fn two_first_sign_ins_at_once_make_one_account() {
    let (_d, pool) = pool().await;
    let (a, b) = tokio::join!(oidc(&pool, "https://idp", "sub-1", "ada"), oidc(&pool, "https://idp", "sub-1", "ada"));
    assert_eq!(a.unwrap().id, b.unwrap().id);
    assert_eq!(users::count(&pool).await.unwrap(), 1);
}
