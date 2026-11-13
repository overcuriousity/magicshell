#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::json;

const PASSWORD: &str = "a long enough password";

struct Run {
    ok: bool,
    code: Option<i32>,
    out: String,
    err: String,
}

/// Runs `magicshell --config <file> <args>` with `stdin` on its standard input.
fn magicshell(config: &std::path::Path, args: &[&str], stdin: &str) -> Run {
    let mut child = Command::new(env!("CARGO_BIN_EXE_magicshell"))
        .arg("--config")
        .arg(config)
        .args(args)
        .env_remove("MAGICSHELL__APP__DATABASE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    Run {
        ok: out.status.success(),
        code: out.status.code(),
        out: String::from_utf8_lossy(&out.stdout).into_owned(),
        err: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

fn config_in(dir: &tempfile::TempDir, toml: &str) -> std::path::PathBuf {
    let file = dir.path().join("magicshell.toml");
    std::fs::write(&file, toml).unwrap();
    file
}

async fn sign_in_status(app: &support::TestApp, name: &str, password: &str) -> u16 {
    support::post_json(app, "/api/auth/sign-in", &json!({"username": name, "password": password}), None)
        .await
        .status()
        .as_u16()
}

#[tokio::test]
async fn a_user_added_from_the_shell_can_sign_in() {
    let dir = tempfile::tempdir().unwrap();
    let file = config_in(&dir, &support::accounts_toml(dir.path()));
    let add = magicshell(&file, &["user", "add", "ada", "--password-stdin"], &format!("{PASSWORD}\n"));
    assert!(add.ok, "{}", add.err);
    let list = magicshell(&file, &["user", "list"], "");
    assert!(list.ok, "{}", list.err);
    assert!(list.out.lines().any(|l| l.starts_with("ada")), "{}", list.out);

    let short = magicshell(&file, &["user", "add", "bob", "--password-stdin"], "short\n");
    assert_eq!(short.code, Some(1));
    assert_eq!(short.err.trim(), "Use at least 12 characters.");
    let odd = magicshell(&file, &["user", "add", "b/b", "--password-stdin"], &format!("{PASSWORD}\n"));
    assert_eq!(odd.code, Some(1));
    assert_eq!(odd.err.trim(), "Use 1 to 64 letters, digits, dots, underscores or hyphens in the name.");
    let twice = magicshell(&file, &["user", "add", "ADA", "--password-stdin"], &format!("{PASSWORD}\n"));
    assert_eq!(twice.code, Some(1));
    assert_eq!(twice.err.trim(), "The username ADA is taken.");

    let new = "another long password";
    let passwd = magicshell(&file, &["user", "passwd", "ada", "--password-stdin"], &format!("{new}\n"));
    assert!(passwd.ok, "{}", passwd.err);
    let weak = magicshell(&file, &["user", "passwd", "ada", "--password-stdin"], "short\n");
    assert_eq!(weak.err.trim(), "Use at least 12 characters.");
    let missing = magicshell(&file, &["user", "passwd", "nobody", "--password-stdin"], &format!("{new}\n"));
    assert_eq!(missing.code, Some(1));
    assert_eq!(missing.err.trim(), "There is no user nobody.");

    let app = support::spawn_in(&std::fs::read_to_string(&file).unwrap(), dir).await;
    assert_eq!(sign_in_status(&app, "ada", PASSWORD).await, 401);
    assert_eq!(sign_in_status(&app, "ada", new).await, 204);
}

#[tokio::test]
async fn a_removed_user_cannot_sign_in() {
    let dir = tempfile::tempdir().unwrap();
    let file = config_in(&dir, &support::accounts_toml(dir.path()));
    for name in ["ada", "bob"] {
        assert!(magicshell(&file, &["user", "add", name, "--password-stdin"], &format!("{PASSWORD}\n")).ok);
    }
    let removed = magicshell(&file, &["user", "remove", "Ada"], "");
    assert!(removed.ok, "{}", removed.err);
    let again = magicshell(&file, &["user", "remove", "ada"], "");
    assert_eq!(again.code, Some(1));
    assert_eq!(again.err.trim(), "There is no user ada.");
    let app = support::spawn_in(&std::fs::read_to_string(&file).unwrap(), dir).await;
    assert_eq!(sign_in_status(&app, "ada", PASSWORD).await, 401);
    assert_eq!(sign_in_status(&app, "bob", PASSWORD).await, 204);
}

#[test]
fn user_commands_explain_that_accounts_are_off() {
    let dir = tempfile::tempdir().unwrap();
    let toml = "[app]\nendpoint = \"http://127.0.0.1:9/v1\"\nmodel = \"test-model\"\n";
    let file = config_in(&dir, toml);
    for args in [
        &["user", "add", "ada", "--password-stdin"][..],
        &["user", "passwd", "ada", "--password-stdin"],
        &["user", "list"],
        &["user", "remove", "ada"],
    ] {
        let run = magicshell(&file, args, &format!("{PASSWORD}\n"));
        assert_eq!(run.code, Some(1), "{args:?}");
        assert_eq!(run.err.trim(), "Accounts are off. Set database under [app] first.", "{args:?}");
        assert!(run.out.is_empty());
    }
}

#[tokio::test]
async fn a_password_set_from_the_shell_ends_the_users_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let file = config_in(&dir, &support::accounts_toml(dir.path()));
    for name in ["ada", "bob"] {
        assert!(magicshell(&file, &["user", "add", name, "--password-stdin"], &format!("{PASSWORD}\n")).ok);
    }
    let app = support::spawn_in(&std::fs::read_to_string(&file).unwrap(), dir).await;
    let ada = support::sign_in(&app, "ada", PASSWORD).await;
    let bob = support::sign_in(&app, "bob", PASSWORD).await;
    assert!(magicshell(&file, &["user", "passwd", "ada", "--password-stdin"], "another long password\n").ok);
    let res = support::post_json(&app, "/api/run", &json!({}), Some(&ada)).await;
    assert_eq!(res.status(), 401);
    let config: serde_json::Value = support::get_with(&app, "/api/config", Some(&bob)).await.json().await.unwrap();
    assert_eq!(config["user"], json!({"username": "bob"}));
}

#[tokio::test]
async fn a_removed_users_cookie_does_not_become_the_next_users() {
    let dir = tempfile::tempdir().unwrap();
    let file = config_in(&dir, &support::accounts_toml(dir.path()));
    for name in ["ada", "bob"] {
        assert!(magicshell(&file, &["user", "add", name, "--password-stdin"], &format!("{PASSWORD}\n")).ok);
    }
    let app = support::spawn_in(&std::fs::read_to_string(&file).unwrap(), dir).await;
    let cookie = support::sign_in(&app, "bob", PASSWORD).await;
    assert!(magicshell(&file, &["user", "remove", "bob"], "").ok);
    assert!(magicshell(&file, &["user", "add", "carol", "--password-stdin"], &format!("{PASSWORD}\n")).ok);
    let res = support::post_json(&app, "/api/run", &json!({}), Some(&cookie)).await;
    assert_eq!(res.status(), 401);
    assert_eq!(res.text().await.unwrap(), "Sign in first.");
}
