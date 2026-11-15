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
fn embedding_is_off_without_a_model() {
    assert!(AppConfig::from_config(&cfg(APP)).unwrap().embedding().is_none());
}

#[test]
fn embedding_defaults_to_the_decision_endpoint_key_and_other_defaults() {
    let toml = format!("{APP}embedding_model = \"embeddinggemma:300m\"\n");
    let app = AppConfig::from_config(&cfg(&toml)).unwrap();
    let e = app.embedding().unwrap();
    assert_eq!(e.endpoint.as_str(), "https://m.example/v1");
    assert_eq!(e.prefix, "");
    assert_eq!(e.min_similarity, 0.75);
    assert_eq!(e.per_minute, 600);
}

#[test]
fn a_separate_endpoint_never_inherits_the_decision_key() {
    let base = "[app]\nendpoint = \"https://m.example/v1\"\nmodel = \"m\"\napi_key = \"main-secret\"\n";
    let same = AppConfig::from_config(&cfg(&format!("{base}embedding_model = \"e\"\n"))).unwrap();
    assert_eq!(same.embedding().unwrap().api_key.unwrap().expose(), "main-secret");
    let separate = AppConfig::from_config(&cfg(&format!(
        "{base}embedding_model = \"e\"\nembedding_endpoint = \"https://e.example/v1\"\n"
    )))
    .unwrap();
    assert!(separate.embedding().unwrap().api_key.is_none());
}

#[test]
fn an_explicit_embedding_key_and_its_file_form_are_read() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("embedding-key");
    std::fs::write(&secret, "file-secret\n").unwrap();
    let base =
        format!("{APP}embedding_model = \"e\"\nembedding_endpoint = \"https://e.example/v1\"\nembedding_api_key = ");
    let explicit = AppConfig::from_config(&cfg(&format!("{base}\"explicit-secret\"\n"))).unwrap();
    assert_eq!(explicit.embedding().unwrap().api_key.unwrap().expose(), "explicit-secret");
    let from_file = AppConfig::from_config(&cfg(&format!("{base}\"file://{}\"\n", secret.display()))).unwrap();
    assert_eq!(from_file.embedding().unwrap().api_key.unwrap().expose(), "file-secret");
}

#[test]
fn embedding_id_tracks_model_endpoint_and_prefix() {
    let make = |extra: &str| {
        let toml = format!("{APP}embedding_model = \"e\"\n{extra}");
        AppConfig::from_config(&cfg(&toml)).unwrap().embedding().unwrap().id
    };
    let plain = make("");
    assert_ne!(plain, make("embedding_prefix = \"query: \"\n"));
    assert_ne!(plain, make("embedding_endpoint = \"https://other.example/v1\"\n"));
    let other_model =
        AppConfig::from_config(&cfg(&format!("{APP}embedding_model = \"other\"\n"))).unwrap().embedding().unwrap().id;
    assert_ne!(plain, other_model);
    assert!(!plain.contains("m.example"));
}

#[test]
fn empty_embedding_models_and_similarity_outside_zero_to_one_are_refused() {
    for extra in [
        "embedding_model = \" \"\n",
        "embedding_model = \"e\"\nembedding_min_similarity = -0.1\n",
        "embedding_model = \"e\"\nembedding_min_similarity = 1.1\n",
    ] {
        assert!(AppConfig::from_config(&cfg(&format!("{APP}{extra}"))).is_err());
    }
}

#[test]
fn non_finite_embedding_similarity_is_refused_with_the_key_name() {
    for similarity in ["nan", "inf", "-inf"] {
        let toml = format!("{APP}embedding_model = \"e\"\nembedding_min_similarity = {similarity}\n");
        let error = AppConfig::from_config(&cfg(&toml)).unwrap_err();
        assert!(error.to_string().contains("embedding_min_similarity"), "{error}");
    }
}

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

/// The config a first `install.sh --system` writes has `data_dir` at the top, before `[app]`,
/// where the server reads it (under `[app]` it is refused).
#[test]
fn the_installer_writes_data_dir_before_the_app_section() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let installer = std::fs::read_to_string(root.join("install.sh")).unwrap();
    let data_dir = installer.find("say \"data_dir = \\\"/var/lib/$app\\\"\"").expect("install.sh writes data_dir");
    let app = installer.find("say \"[app]\"").expect("install.sh writes [app]");
    assert!(data_dir < app);
}
