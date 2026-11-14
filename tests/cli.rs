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
    magicshell_with(config, args, stdin, &[])
}

/// Like `magicshell`, with environment variables set (`Some`) or removed (`None`).
fn magicshell_with(config: &std::path::Path, args: &[&str], stdin: &str, env: &[(&str, Option<&str>)]) -> Run {
    let mut command = Command::new(env!("CARGO_BIN_EXE_magicshell"));
    command.arg("--config").arg(config).args(args).env_remove("MAGICSHELL__APP__DATABASE");
    for (key, value) in env {
        match value {
            Some(v) => command.env(key, v),
            None => command.env_remove(key),
        };
    }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
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
    support::create_database(dir.path()).await;
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
    support::create_database(dir.path()).await;
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
    support::create_database(dir.path()).await;
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
    assert_eq!(config["user"], json!({"username": "bob", "password": true}));
}

#[tokio::test]
async fn a_removed_users_cookie_does_not_become_the_next_users() {
    let dir = tempfile::tempdir().unwrap();
    let file = config_in(&dir, &support::accounts_toml(dir.path()));
    support::create_database(dir.path()).await;
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

const USER_COMMANDS: [&[&str]; 4] = [
    &["user", "add", "ada", "--password-stdin"],
    &["user", "passwd", "ada", "--password-stdin"],
    &["user", "list"],
    &["user", "remove", "ada"],
];

#[test]
fn a_user_command_never_creates_a_database() {
    let dir = tempfile::tempdir().unwrap();
    let file = config_in(&dir, &support::accounts_toml(dir.path()));
    let database = dir.path().join("magicshell.db");
    for args in USER_COMMANDS {
        let run = magicshell(&file, args, &format!("{PASSWORD}\n"));
        assert_eq!(run.code, Some(1), "{args:?}");
        assert_eq!(
            run.err.trim(),
            format!("There is no database at {}. Start or restart magicshell once to create it.", database.display()),
            "{args:?}"
        );
        assert!(run.out.is_empty());
        assert!(!database.exists(), "{args:?}");
    }
}

/// The system install: no `data_dir` in the config, the service's directory comes from systemd.
#[tokio::test]
async fn without_data_dir_the_state_directory_decides() {
    let state = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let file =
        config_in(&state, "[app]\nendpoint = \"http://127.0.0.1:9/v1\"\nmodel = \"m\"\ndatabase = \"magicshell.db\"\n");
    support::create_database(state.path()).await;
    let state_dir = state.path().to_str().unwrap();
    let home_dir = home.path().to_str().unwrap();

    let service = [("STATE_DIRECTORY", Some(state_dir))];
    let run = magicshell_with(&file, USER_COMMANDS[0], &format!("{PASSWORD}\n"), &service);
    assert!(run.ok, "{}", run.err);
    assert_eq!(run.out.trim(), "Added ada.");

    let shell = [("STATE_DIRECTORY", None), ("XDG_DATA_HOME", None), ("HOME", Some(home_dir))];
    let run = magicshell_with(&file, &["user", "list"], "", &shell);
    assert_eq!(run.code, Some(1));
    let stray = home.path().join(".local/share/magicshell/magicshell.db");
    assert_eq!(
        run.err.trim(),
        format!("There is no database at {}. Start or restart magicshell once to create it.", stray.display())
    );
    assert!(std::fs::read_dir(home.path()).unwrap().next().is_none(), "nothing may be created in the home directory");
}

#[cfg(unix)]
#[tokio::test]
async fn a_database_that_cannot_be_read_says_run_as_root() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("private");
    std::fs::create_dir(&data).unwrap();
    let file = config_in(&dir, &support::accounts_toml(&data));
    support::create_database(&data).await;
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o000)).unwrap();
    // Root reads everything, so there is nothing to see as root.
    let locked = std::fs::read_dir(&data).is_err();
    let run = magicshell(&file, &["user", "list"], "");
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
    if !locked {
        return;
    }
    assert_eq!(run.code, Some(1));
    assert_eq!(
        run.err.trim(),
        format!("Cannot open the database at {}. Run this command as root.", data.join("magicshell.db").display())
    );
}

fn sso_config(dir: &tempfile::TempDir) -> std::path::PathBuf {
    let toml = format!(
        "{}[auth.oidc]\nissuer = \"http://127.0.0.1:9\"\nclient_id = \"magicshell\"\nclient_secret = \"s\"\n",
        support::accounts_toml(dir.path())
    );
    config_in(dir, &toml)
}

#[tokio::test]
async fn password_commands_work_in_sso_mode() {
    use magicshell::kit::identity::users;
    let dir = tempfile::tempdir().unwrap();
    let file = sso_config(&dir);
    support::create_database(dir.path()).await;
    let add = magicshell(&file, USER_COMMANDS[0], &format!("{PASSWORD}\n"));
    assert!(add.ok, "{}", add.err);
    assert_eq!(add.out.trim(), "Added ada.");
    let pool = magicshell::kit::db::connect(dir.path(), "magicshell.db").await.unwrap();
    assert!(users::verify_password(&pool, "ada", PASSWORD).await.unwrap().is_some());

    let passwd = magicshell(&file, USER_COMMANDS[1], "another long password\n");
    assert!(passwd.ok, "{}", passwd.err);
    assert!(users::verify_password(&pool, "ada", PASSWORD).await.unwrap().is_none());
    assert!(users::verify_password(&pool, "ada", "another long password").await.unwrap().is_some());
}

#[tokio::test]
async fn list_and_remove_work_in_sso_mode() {
    use magicshell::kit::identity::users;
    let dir = tempfile::tempdir().unwrap();
    let file = sso_config(&dir);
    support::create_database(dir.path()).await;
    let pool = magicshell::kit::db::connect(dir.path(), "magicshell.db").await.unwrap();
    let now = time::OffsetDateTime::now_utc();
    users::find_or_provision_oidc(&pool, "http://127.0.0.1:9", "sub-ada", "Ada L@cloud", true, now).await.unwrap();

    let list = magicshell(&file, &["user", "list"], "");
    assert!(list.ok, "{}", list.err);
    assert!(list.out.starts_with("Ada L@cloud\t"), "{}", list.out);

    let removed = magicshell(&file, &["user", "remove", "Ada L@cloud"], "");
    assert!(removed.ok, "{}", removed.err);
    assert_eq!(removed.out.trim(), "Removed Ada L@cloud.");
    let identities: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oidc_identities").fetch_one(&pool).await.unwrap();
    assert_eq!(identities, 0);
}

#[tokio::test]
async fn list_shows_the_way_in() {
    use magicshell::kit::identity::users;
    let dir = tempfile::tempdir().unwrap();
    let file = sso_config(&dir);
    support::create_database(dir.path()).await;
    assert!(magicshell(&file, USER_COMMANDS[0], &format!("{PASSWORD}\n")).ok);
    let pool = magicshell::kit::db::connect(dir.path(), "magicshell.db").await.unwrap();
    let now = time::OffsetDateTime::now_utc();
    users::find_or_provision_oidc(&pool, "http://127.0.0.1:9", "sub-grace", "grace", true, now).await.unwrap();

    let list = magicshell(&file, &["user", "list"], "");
    assert!(list.ok, "{}", list.err);
    let rows: Vec<Vec<&str>> = list.out.lines().map(|l| l.split('\t').collect()).collect();
    assert_eq!(rows.len(), 2, "{}", list.out);
    let today = now.date().to_string();
    assert_eq!(rows[0], ["ada", today.as_str(), "password"]);
    assert_eq!(rows[1], ["grace", today.as_str(), "provider"]);
}

#[tokio::test]
async fn passwd_refuses_a_provider_account() {
    use magicshell::kit::identity::users;
    let dir = tempfile::tempdir().unwrap();
    let file = sso_config(&dir);
    support::create_database(dir.path()).await;
    let pool = magicshell::kit::db::connect(dir.path(), "magicshell.db").await.unwrap();
    let now = time::OffsetDateTime::now_utc();
    users::find_or_provision_oidc(&pool, "http://127.0.0.1:9", "sub-grace", "grace", true, now).await.unwrap();

    let passwd = magicshell(&file, &["user", "passwd", "grace", "--password-stdin"], &format!("{PASSWORD}\n"));
    assert_eq!(passwd.code, Some(1));
    assert_eq!(passwd.err.trim(), "grace signs in through the provider and has no password.");
    assert!(passwd.out.is_empty());
    assert!(users::verify_password(&pool, "grace", PASSWORD).await.unwrap().is_none());
}
