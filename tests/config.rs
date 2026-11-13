#![allow(clippy::unwrap_used, clippy::expect_used)]

use magicshell::config::AppConfig;
use magicshell::kit::config::{OcConfig, Secret, load};

fn cfg(toml: &str) -> OcConfig {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.toml");
    std::fs::write(&path, toml).unwrap();
    load::<OcConfig>("octest", Some(&path)).unwrap()
}

#[test]
fn no_public_url_on_loopback_means_http_localhost() {
    let d = cfg("").deployment().unwrap();
    assert_eq!(d.origin, "http://localhost:8080");
    assert!(!d.secure);
    assert!(d.host_allowed("127.0.0.1:8080") && d.host_allowed("localhost:8080"));
    assert!(!d.host_allowed("evil.example"));
}

#[test]
fn no_public_url_on_a_non_loopback_bind_is_refused() {
    let e = cfg("bind = \"0.0.0.0:8080\"").deployment().unwrap_err();
    assert_eq!(e.to_string(), "Set public_url when binding to a non-loopback address.");
}

#[test]
fn an_http_public_url_on_a_non_loopback_host_is_refused() {
    let e = cfg("public_url = \"http://notes.lan\"").deployment().unwrap_err();
    assert_eq!(e.to_string(), "public_url must be https unless it is localhost.");
}

#[test]
fn an_https_public_url_sets_secure_and_the_host_check_to_its_host() {
    let d = cfg("public_url = \"https://notes.example\"").deployment().unwrap();
    assert!(d.secure);
    assert_eq!(d.origin, "https://notes.example");
    assert!(d.host_allowed("notes.example") && !d.host_allowed("localhost:8080"));
}

#[derive(serde::Deserialize)]
struct Keyed {
    key: Secret,
}

#[test]
fn env_overrides_and_file_secrets_are_read() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("s");
    std::fs::write(&secret, "hunter2\n").unwrap();
    temp_env::with_vars([("OCENV__KEY_FILE", Some(secret.to_str().unwrap()))], || {
        let k = load::<Keyed>("ocenv", None).unwrap();
        assert_eq!(k.key.expose(), "hunter2");
        assert_eq!(format!("{:?}", k.key), "Secret(***)");
    });
    temp_env::with_vars([("OCENV__BIND", Some("127.0.0.1:9000"))], || {
        assert_eq!(load::<OcConfig>("ocenv", None).unwrap().bind.port(), 9000);
    });
}

#[test]
fn unknown_keys_are_rejected_with_the_key_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.toml");
    std::fs::write(&path, "bnid = \"x\"").unwrap();
    let e = load::<OcConfig>("octest", Some(&path)).unwrap_err();
    assert!(e.to_string().contains("bnid"), "{e}");
}

#[test]
fn any_key_can_be_read_from_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("url");
    std::fs::write(&f, "https://notes.example\n").unwrap();
    temp_env::with_vars([("OCFILE__PUBLIC_URL_FILE", Some(f.to_str().unwrap()))], || {
        let c = load::<OcConfig>("ocfile", None).unwrap();
        assert_eq!(c.public_url.unwrap().as_str(), "https://notes.example/");
    });
}

const APP: &str = "[app]\nendpoint = \"https://m.example/v1\"\nmodel = \"m\"\ndatabase = \"x.db\"\n";
const OIDC: &str =
    "[auth.oidc]\nissuer = \"https://cloud.example\"\nclient_id = \"magicshell\"\nclient_secret = \"s\"\n";

#[test]
fn the_oidc_section_is_read_with_its_defaults() {
    let c = cfg(&format!("{APP}{OIDC}"));
    let oidc = AppConfig::from_config(&c).unwrap().oidc.unwrap();
    assert_eq!(oidc.issuer, "https://cloud.example");
    assert_eq!(oidc.scopes, ["openid", "profile"]);
    assert!(!oidc.auto_provision);
    assert_eq!(oidc.display_name, "Sign in with SSO");
    assert_eq!(oidc.client_secret.expose(), "s");
}

#[test]
fn no_oidc_section_means_none() {
    assert!(AppConfig::from_config(&cfg(APP)).unwrap().oidc.is_none());
}

#[test]
fn oidc_without_a_database_is_refused() {
    let app = "[app]\nendpoint = \"https://m.example/v1\"\nmodel = \"m\"\n";
    let e = AppConfig::from_config(&cfg(&format!("{app}{OIDC}"))).unwrap_err();
    assert_eq!(e.to_string(), "Sign-in through [auth.oidc] needs accounts. Set database under [app].");
}

#[test]
fn an_issuer_that_is_no_url_is_refused() {
    let oidc = OIDC.replace("https://cloud.example", "cloud");
    let e = AppConfig::from_config(&cfg(&format!("{APP}{oidc}"))).unwrap_err();
    assert_eq!(e.to_string(), "auth.oidc.issuer is not a URL: cloud.");
}

#[test]
fn an_unknown_oidc_key_is_rejected_with_its_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.toml");
    std::fs::write(&path, format!("{OIDC}groups = []\n")).unwrap();
    let e = load::<OcConfig>("octest", Some(&path)).unwrap_err();
    assert!(e.to_string().contains("groups"), "{e}");
}

#[test]
fn the_oidc_secret_can_come_from_the_environment() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.toml");
    std::fs::write(&path, OIDC).unwrap();
    temp_env::with_vars([("OCOIDC__AUTH__OIDC__CLIENT_SECRET", Some("from-env"))], || {
        let c = load::<OcConfig>("ocoidc", Some(&path)).unwrap();
        assert_eq!(c.auth.oidc.unwrap().client_secret.expose(), "from-env");
    });
}
