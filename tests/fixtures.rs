//! Runs the shared System One fixtures (also used by the JS tests) against the Rust implementation.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::fs;
use std::path::PathBuf;

use magicshell::systemone::{Run, parse_response, request_json};
use serde_json::Value;

fn fixtures(prefix: &str) -> Vec<(String, Value)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/systemone");
    let mut found = Vec::new();
    for entry in fs::read_dir(&dir).expect("fixtures directory") {
        let path = entry.expect("fixture entry").path();
        let name = path.file_name().expect("file name").to_string_lossy().into_owned();
        if name.starts_with(prefix) && name.ends_with(".json") {
            let text = fs::read_to_string(&path).expect("fixture text");
            found.push((name, serde_json::from_str(&text).expect("fixture json")));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!found.is_empty(), "no {prefix} fixtures found");
    found
}

fn run_of(fixture: &Value) -> Run {
    serde_json::from_value(fixture["run"].clone()).expect("fixture run")
}

#[test]
fn every_request_fixture_produces_the_expected_text() {
    for (name, f) in fixtures("request-") {
        let run = run_of(&f);
        let model = f["model"].as_str().expect("model");
        assert_eq!(run.validate().map_err(|e| e.to_string()), Ok(()), "{name}");
        assert_eq!(request_json(&run, model), f["expected_json"].as_str().expect("text"), "{name}");
    }
}

#[test]
fn every_response_fixture_is_read_as_expected() {
    for (name, f) in fixtures("response-") {
        let run = run_of(&f);
        let body = (!f["body"].is_null()).then(|| &f["body"]);
        let got = parse_response(body, &run);
        match f["expected"].get("error") {
            Some(error) => {
                assert_eq!(got.map_err(|e| e.to_string()).err().as_deref(), error.as_str(), "{name}");
            }
            None => {
                let outcome = got.unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(serde_json::to_value(&outcome).expect("outcome json"), f["expected"], "{name}");
            }
        }
    }
}

#[test]
fn every_invalid_fixture_is_refused_with_its_sentence() {
    for (name, f) in fixtures("invalid-") {
        let got = run_of(&f).validate().map_err(|e| e.to_string());
        assert_eq!(got.err().as_deref(), f["expected_error"].as_str(), "{name}");
    }
}
