#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use serde_json::{Value, json};
use support::{ACCOUNTS, OPEN, TestApp, add_user, get_with, sign_in, spawn};

const PASSWORD: &str = "a long enough password";

fn url(app: &TestApp, path: &str) -> String {
    format!("{}{path}", app.base)
}

async fn put(app: &TestApp, path: &str, body: &Value, cookie: Option<&str>) -> reqwest::Response {
    let mut req = app.client.put(url(app, path)).header("origin", &app.base).json(body);
    if let Some(c) = cookie {
        req = req.header("cookie", c);
    }
    req.send().await.unwrap()
}

async fn delete(app: &TestApp, path: &str, cookie: Option<&str>) -> reqwest::Response {
    let mut req = app.client.delete(url(app, path)).header("origin", &app.base);
    if let Some(c) = cookie {
        req = req.header("cookie", c);
    }
    req.send().await.unwrap()
}

async fn list(app: &TestApp, path: &str, cookie: &str) -> Vec<Value> {
    let res = get_with(app, path, Some(cookie)).await;
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

async fn two_users() -> (TestApp, String, String) {
    let app = spawn(ACCOUNTS).await;
    add_user(&app, "ada", PASSWORD).await;
    add_user(&app, "bob", PASSWORD).await;
    let ada = sign_in(&app, "ada", PASSWORD).await;
    let bob = sign_in(&app, "bob", PASSWORD).await;
    (app, ada, bob)
}

fn setup(id: &str, name: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "sampleState": "The server crashed twice today.",
        "questions": [{
            "key": "team", "type": "choice", "text": "Which team?",
            "options": [{"id": "o1", "name": "ops", "description": ""}, {"id": "o2", "name": "support"}]
        }]
    })
}

fn entry(id: &str, at: &str) -> Value {
    json!({
        "id": id,
        "at": at,
        "guided": true,
        "run": {"state": "s", "questions": [{"key": "k", "type": "noul", "text": "Anything?"}]},
        "reply": {"answers": {"k": {"type": "noul", "noul": 0.5}}, "model": "m", "inputTokens": 3},
        "totalMs": 812
    })
}

fn entry_with_why(id: &str, at: &str, why: Value) -> Value {
    let mut e = entry(id, at);
    e["why"] = why;
    e
}

fn fitting_why() -> Value {
    json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [0.5], "flips": {"0": false}}}})
}

#[tokio::test]
async fn a_saved_setup_is_listed() {
    let (app, ada, _bob) = two_users().await;
    assert_eq!(put(&app, "/api/setups/b-1", &setup("b-1", "Beta"), Some(&ada)).await.status(), 204);
    assert_eq!(put(&app, "/api/setups/a-1", &setup("a-1", "alpha"), Some(&ada)).await.status(), 204);
    let got = list(&app, "/api/setups", &ada).await;
    let names: Vec<&str> = got.iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["alpha", "Beta"]);
    assert_eq!(got[0]["sampleState"], "The server crashed twice today.");
    assert_eq!(got[0]["questions"][0]["key"], "team");
}

#[tokio::test]
async fn saving_a_setup_again_replaces_it() {
    let (app, ada, _bob) = two_users().await;
    put(&app, "/api/setups/s1", &setup("s1", "First"), Some(&ada)).await;
    assert_eq!(put(&app, "/api/setups/s1", &setup("s1", "Renamed"), Some(&ada)).await.status(), 204);
    let got = list(&app, "/api/setups", &ada).await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["name"], "Renamed");
}

#[tokio::test]
async fn a_setup_with_an_unnamed_option_is_refused() {
    let (app, ada, _bob) = two_users().await;
    let mut bad = setup("s1", "Bad");
    bad["questions"][0]["options"] = json!([{"id": "o1", "name": "ops"}, {"id": "o2", "name": "  "}]);
    let res = put(&app, "/api/setups/s1", &bad, Some(&ada)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "Name every option.");
    assert!(list(&app, "/api/setups", &ada).await.is_empty());
}

#[tokio::test]
async fn a_setup_may_have_an_empty_question_text_but_needs_a_name() {
    let (app, ada, _bob) = two_users().await;
    let mut yes_no = setup("s1", "Yes or no");
    yes_no["questions"][0]["text"] = json!("");
    assert_eq!(put(&app, "/api/setups/s1", &yes_no, Some(&ada)).await.status(), 204);

    for (name, sentence) in
        [("  ", "Name the setup."), (&"x".repeat(61), "Keep the setup name to 60 characters or fewer.")]
    {
        let res = put(&app, "/api/setups/s2", &setup("s2", name), Some(&ada)).await;
        assert_eq!(res.status(), 422);
        assert_eq!(res.text().await.unwrap(), sentence);
    }
}

#[tokio::test]
async fn ids_must_be_plain_and_agree() {
    let (app, ada, _bob) = two_users().await;
    for bad in ["has space", "semi;colon", &"a".repeat(65)] {
        let res = put(&app, &format!("/api/setups/{bad}"), &setup(bad, "N"), Some(&ada)).await;
        assert_eq!(res.status(), 422, "{bad}");
        assert_eq!(res.text().await.unwrap(), "This id is not valid.");
    }
    let res = put(&app, "/api/setups/one", &setup("two", "N"), Some(&ada)).await;
    assert_eq!(res.status(), 422);
    let res = put(&app, "/api/history/one", &entry("two", "2026-11-13T10:00:00Z"), Some(&ada)).await;
    assert_eq!(res.status(), 422);
}

#[tokio::test]
async fn a_hundred_and_first_setup_is_refused_but_replacing_is_fine() {
    let (app, ada, _bob) = two_users().await;
    for i in 0..100 {
        let id = format!("s{i}");
        assert_eq!(put(&app, &format!("/api/setups/{id}"), &setup(&id, &id), Some(&ada)).await.status(), 204);
    }
    let res = put(&app, "/api/setups/extra", &setup("extra", "Extra"), Some(&ada)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "Delete a setup before adding another.");
    assert_eq!(put(&app, "/api/setups/s7", &setup("s7", "Seven"), Some(&ada)).await.status(), 204);
}

#[tokio::test]
async fn a_deleted_setup_can_be_put_back_under_the_same_id() {
    let (app, ada, _bob) = two_users().await;
    put(&app, "/api/setups/s1", &setup("s1", "One"), Some(&ada)).await;
    assert_eq!(delete(&app, "/api/setups/s1", Some(&ada)).await.status(), 204);
    assert!(list(&app, "/api/setups", &ada).await.is_empty());
    assert_eq!(put(&app, "/api/setups/s1", &setup("s1", "Again"), Some(&ada)).await.status(), 204);
    assert_eq!(list(&app, "/api/setups", &ada).await[0]["name"], "Again");
}

#[tokio::test]
async fn one_user_cannot_see_or_delete_anothers_setup() {
    let (app, ada, bob) = two_users().await;
    put(&app, "/api/setups/s1", &setup("s1", "Ada's"), Some(&ada)).await;
    assert!(list(&app, "/api/setups", &bob).await.is_empty());
    assert_eq!(delete(&app, "/api/setups/s1", Some(&bob)).await.status(), 204);
    assert_eq!(list(&app, "/api/setups", &ada).await.len(), 1);
    // The same id under another user is a separate setup.
    put(&app, "/api/setups/s1", &setup("s1", "Bob's"), Some(&bob)).await;
    assert_eq!(list(&app, "/api/setups", &ada).await[0]["name"], "Ada's");
    assert_eq!(list(&app, "/api/setups", &bob).await[0]["name"], "Bob's");
}

#[tokio::test]
async fn history_is_listed_newest_first() {
    let (app, ada, _bob) = two_users().await;
    for (id, at) in [
        ("e1", "2026-11-13T10:00:00Z"),
        ("e3", "2026-11-13T12:00:00.5Z"),
        ("e2", "2026-11-13T13:00:00+02:00"), // 11:00 UTC
    ] {
        assert_eq!(put(&app, &format!("/api/history/{id}"), &entry(id, at), Some(&ada)).await.status(), 204);
    }
    let got = list(&app, "/api/history", &ada).await;
    let ids: Vec<&str> = got.iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["e3", "e2", "e1"]);
    assert_eq!(got[0]["reply"]["inputTokens"], 3);
    assert_eq!(got[0]["totalMs"], 812);
    assert_eq!(got[0]["run"]["questions"][0]["key"], "k");
}

#[tokio::test]
async fn a_bad_entry_is_refused() {
    let (app, ada, _bob) = two_users().await;
    let mut bad = entry("e1", "yesterday");
    let res = put(&app, "/api/history/e1", &bad, Some(&ada)).await;
    assert_eq!(res.status(), 422);
    bad["at"] = json!("2026-11-13T10:00:00Z");
    bad["reply"] = json!("not an object");
    assert_eq!(put(&app, "/api/history/e1", &bad, Some(&ada)).await.status(), 422);
    assert!(list(&app, "/api/history", &ada).await.is_empty());
}

#[tokio::test]
async fn the_501st_entry_drops_the_oldest() {
    let (app, ada, bob) = two_users().await;
    put(&app, "/api/history/bobs", &entry("bobs", "2026-01-01T00:00:00Z"), Some(&bob)).await;
    for i in 0..501 {
        let id = format!("e{i:03}");
        let at = format!("2026-11-13T10:{:02}:{:02}Z", i / 60, i % 60);
        assert_eq!(put(&app, &format!("/api/history/{id}"), &entry(&id, &at), Some(&ada)).await.status(), 204);
    }
    let got = list(&app, "/api/history", &ada).await;
    assert_eq!(got.len(), 500);
    assert_eq!(got[0]["id"], "e500");
    assert_eq!(got[499]["id"], "e001");
    assert_eq!(list(&app, "/api/history", &bob).await.len(), 1);
}

#[tokio::test]
async fn an_entry_older_than_the_500_newest_is_refused() {
    let (app, ada, _bob) = two_users().await;
    for i in 0..500 {
        let id = format!("e{i:03}");
        let at = format!("2026-11-13T10:{:02}:{:02}Z", i / 60, i % 60);
        assert_eq!(put(&app, &format!("/api/history/{id}"), &entry(&id, &at), Some(&ada)).await.status(), 204);
    }
    let res = put(&app, "/api/history/old", &entry("old", "2026-01-01T00:00:00Z"), Some(&ada)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "History keeps only its 500 newest entries, and this one is older.");
    let got = list(&app, "/api/history", &ada).await;
    assert_eq!(got.len(), 500);
    assert!(got.iter().all(|e| e["id"] != "old"));
    assert_eq!(got[499]["id"], "e000");
}

#[tokio::test]
async fn a_negative_duration_is_refused() {
    let (app, ada, _bob) = two_users().await;
    let mut bad = entry("e1", "2026-11-13T10:00:00Z");
    bad["totalMs"] = json!(-1);
    let res = put(&app, "/api/history/e1", &bad, Some(&ada)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "The duration of this entry is not valid.");
    bad["totalMs"] = json!(-0.5);
    assert_eq!(put(&app, "/api/history/e1", &bad, Some(&ada)).await.status(), 422);
    assert!(list(&app, "/api/history", &ada).await.is_empty());
    bad["totalMs"] = json!(0);
    assert_eq!(put(&app, "/api/history/e1", &bad, Some(&ada)).await.status(), 204);
}

#[tokio::test]
async fn deleting_one_entry_and_clearing_history() {
    let (app, ada, _bob) = two_users().await;
    for id in ["e1", "e2"] {
        put(&app, &format!("/api/history/{id}"), &entry(id, "2026-11-13T10:00:00Z"), Some(&ada)).await;
    }
    assert_eq!(delete(&app, "/api/history/e1", Some(&ada)).await.status(), 204);
    assert_eq!(list(&app, "/api/history", &ada).await.len(), 1);
}

#[tokio::test]
async fn clearing_history_leaves_other_users_alone() {
    let (app, ada, bob) = two_users().await;
    put(&app, "/api/history/e1", &entry("e1", "2026-11-13T10:00:00Z"), Some(&ada)).await;
    put(&app, "/api/history/e1", &entry("e1", "2026-11-13T10:00:00Z"), Some(&bob)).await;
    assert_eq!(delete(&app, "/api/history", Some(&ada)).await.status(), 204);
    assert!(list(&app, "/api/history", &ada).await.is_empty());
    assert_eq!(list(&app, "/api/history", &bob).await.len(), 1);
}

#[tokio::test]
async fn removing_a_user_removes_their_setups_and_history() {
    let (app, ada, bob) = two_users().await;
    put(&app, "/api/setups/s1", &setup("s1", "One"), Some(&ada)).await;
    put(&app, "/api/history/e1", &entry("e1", "2026-11-13T10:00:00Z"), Some(&ada)).await;
    put(&app, "/api/setups/s1", &setup("s1", "One"), Some(&bob)).await;
    let pool = app.pool.as_ref().unwrap();
    assert!(magicshell::kit::identity::users::delete_by_username(pool, "ada").await.unwrap());
    let setups: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM setups").fetch_one(pool).await.unwrap();
    let history: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history").fetch_one(pool).await.unwrap();
    assert_eq!((setups, history), (1, 0));
}

#[tokio::test]
async fn storage_does_not_exist_in_open_mode() {
    let app = spawn(OPEN).await;
    assert_eq!(get_with(&app, "/api/setups", None).await.status(), 404);
    assert_eq!(get_with(&app, "/api/history", None).await.status(), 404);
    assert_eq!(put(&app, "/api/setups/s1", &setup("s1", "One"), None).await.status(), 404);
    assert_eq!(delete(&app, "/api/history", None).await.status(), 404);
}

#[tokio::test]
async fn storage_needs_a_signed_in_user() {
    let (app, _ada, _bob) = two_users().await;
    for res in [
        get_with(&app, "/api/setups", None).await,
        get_with(&app, "/api/history", None).await,
        put(&app, "/api/setups/s1", &setup("s1", "One"), None).await,
        put(&app, "/api/history/e1", &entry("e1", "2026-11-13T10:00:00Z"), None).await,
        delete(&app, "/api/setups/s1", None).await,
        delete(&app, "/api/history/e1", None).await,
        delete(&app, "/api/history", None).await,
    ] {
        assert_eq!(res.status(), 401);
        assert_eq!(res.text().await.unwrap(), "Sign in first.");
    }
}

#[tokio::test]
async fn an_entry_keeps_its_why_part() {
    let (app, ada, _bob) = two_users().await;
    let e = entry_with_why("e1", "2026-11-13T10:00:00Z", fitting_why());
    assert_eq!(put(&app, "/api/history/e1", &e, Some(&ada)).await.status(), 204);
    assert_eq!(list(&app, "/api/history", &ada).await[0]["why"], fitting_why());
}

#[tokio::test]
async fn an_entry_without_a_why_part_lists_without_one() {
    let (app, ada, _bob) = two_users().await;
    put(&app, "/api/history/e1", &entry("e1", "2026-11-13T10:00:00Z"), Some(&ada)).await;
    assert!(list(&app, "/api/history", &ada).await[0].get("why").is_none());
}

#[tokio::test]
async fn a_why_part_that_does_not_fit_is_refused() {
    let (app, ada, _bob) = two_users().await;
    let cases: Vec<(&str, Value)> = vec![
        ("version", json!({"v": 2, "words": 1, "done": 1, "q": {"k": {"vals": [0.5], "flips": {}}}})),
        ("done over words", json!({"v": 1, "words": 1, "done": 2, "q": {"k": {"vals": [0.5, 0.5], "flips": {}}}})),
        ("words differ", json!({"v": 1, "words": 2, "done": 1, "q": {"k": {"vals": [0.5], "flips": {}}}})),
        (
            "foreign key",
            json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [0.5], "flips": {}}, "z": {"vals": [0.5], "flips": {}}}}),
        ),
        ("question missing", json!({"v": 1, "words": 1, "done": 1, "q": {}})),
        ("vals too short", json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [], "flips": {}}}})),
        ("vals too long", json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [0.5, 0.5], "flips": {}}}})),
        ("null val", json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [null], "flips": {}}}})),
        (
            "flip index out of range",
            json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [0.5], "flips": {"7": true}}}}),
        ),
        (
            "flip key not a number",
            json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [0.5], "flips": {"x": true}}}}),
        ),
        ("flip string", json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [0.5], "flips": {"0": "a"}}}})),
        ("flip object", json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [0.5], "flips": {"0": {}}}}})),
        ("flip negative", json!({"v": 1, "words": 1, "done": 1, "q": {"k": {"vals": [0.5], "flips": {"0": -1}}}})),
        ("unknown field", json!({"v": 1, "words": 1, "done": 1, "extra": 1, "q": {"k": {"vals": [0.5], "flips": {}}}})),
    ];
    for (name, why) in cases {
        let res = put(&app, "/api/history/e1", &entry_with_why("e1", "2026-11-13T10:00:00Z", why), Some(&ada)).await;
        assert_eq!(res.status(), 422, "{name}");
        assert_eq!(res.text().await.unwrap(), "The kept Why? result of this entry is not valid.", "{name}");
    }
    assert!(list(&app, "/api/history", &ada).await.is_empty());
}

/// A part of exactly `len` bytes (as `serde_json::to_string` writes it), with its run.
fn why_of_length(len: usize) -> (Value, Value) {
    let words = 1700;
    let vals = vec![0.1234567; words];
    let flips: serde_json::Map<String, Value> = (0..words).map(|i| (i.to_string(), json!(false))).collect();
    let part = |key: &str| json!({"v": 1, "words": words, "done": words, "q": {key: {"vals": vals, "flips": flips}}});
    let base = serde_json::to_string(&part("k")).unwrap().len();
    assert!(base <= len, "the base part is already {base} bytes");
    let key = format!("k{}", "x".repeat(len - base));
    let run =
        json!({"state": vec!["a"; words].join(" "), "questions": [{"key": key, "type": "noul", "text": "Anything?"}]});
    let why = part(&key);
    assert_eq!(serde_json::to_string(&why).unwrap().len(), len);
    (why, run)
}

#[tokio::test]
async fn a_why_part_well_over_the_old_40_kb_is_kept() {
    let (app, ada, _bob) = two_users().await;
    let (why, run) = why_of_length(200 * 1024);
    let mut e = entry_with_why("e1", "2026-11-13T10:00:00Z", why);
    e["run"] = run;
    assert_eq!(put(&app, "/api/history/e1", &e, Some(&ada)).await.status(), 204);
}

fn preview(chars: usize) -> String {
    let prefix = "data:image/jpeg;base64,/9j/";
    format!("{prefix}{}", "A".repeat(chars - prefix.len()))
}

fn entry_with_pictures(id: &str, pictures: Value) -> Value {
    let mut e = entry(id, "2026-11-13T10:00:00Z");
    e["pictures"] = pictures;
    e
}

#[tokio::test]
async fn an_entry_keeps_its_previews() {
    let (app, ada, _) = two_users().await;
    let pictures = json!([
        { "preview": preview(4000), "width": 768, "height": 576, "bytes": 84_000 },
        { "width": 640, "height": 480, "bytes": 51_000 },
    ]);
    let e = entry_with_pictures("e1", pictures.clone());
    assert_eq!(put(&app, "/api/history/e1", &e, Some(&ada)).await.status(), 204);
    let got = list(&app, "/api/history", &ada).await;
    assert_eq!(got[0]["pictures"], pictures);
}

#[tokio::test]
async fn an_entry_without_pictures_is_stored_as_before() {
    let (app, ada, _) = two_users().await;
    let e = entry("e1", "2026-11-13T10:00:00Z");
    assert_eq!(put(&app, "/api/history/e1", &e, Some(&ada)).await.status(), 204);
    let got = list(&app, "/api/history", &ada).await;
    assert_eq!(got[0]["run"]["state"], e["run"]["state"]);
    assert!(got[0].get("pictures").is_none());
    assert!(got[0]["run"].get("images").is_none());
}

#[tokio::test]
async fn an_entry_with_pictures_in_its_run_is_refused() {
    let (app, ada, _) = two_users().await;
    let mut e = entry("e1", "2026-11-13T10:00:00Z");
    e["run"]["images"] = json!(["data:image/jpeg;base64,/9j/4AAQ"]);
    let res = put(&app, "/api/history/e1", &e, Some(&ada)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "History does not keep pictures.");
}

#[tokio::test]
async fn a_bad_preview_is_refused() {
    let (app, ada, _) = two_users().await;
    let part = |preview: String| json!([{ "preview": preview, "width": 1, "height": 1, "bytes": 1 }]);
    let five = json!(vec![json!({ "width": 1, "height": 1, "bytes": 1 }); 5]);
    for pictures in
        [part(preview(4001)), part("data:image/png;base64,AAAA".into()), part("https://example.org/a.jpg".into()), five]
    {
        let res = put(&app, "/api/history/e1", &entry_with_pictures("e1", pictures), Some(&ada)).await;
        assert_eq!(res.status(), 422);
        assert_eq!(res.text().await.unwrap(), "A preview of this entry is not valid.");
    }
    let unknown = json!([{ "url": "x", "width": 1, "height": 1, "bytes": 1 }]);
    assert_eq!(put(&app, "/api/history/e1", &entry_with_pictures("e1", unknown), Some(&ada)).await.status(), 422);
}

#[tokio::test]
async fn a_history_entry_of_200_kb_is_kept() {
    let (app, ada, _) = two_users().await;
    let options: Vec<Value> = (0..60)
        .map(|i| json!({"id": format!("o{i}"), "name": format!("option number {i} {}", "x".repeat(40))}))
        .collect();
    let questions: Vec<Value> = (0..8)
        .map(|q| json!({"key": format!("q{q}"), "type": "choice", "text": "Which?", "options": options}))
        .collect();
    let answers: serde_json::Map<String, Value> = (0..8)
        .map(|q| {
            let p = vec![1.0 / 60.0; 60];
            (
                format!("q{q}"),
                json!({"type": "choice", "choice": "option number 0", "probabilities": p, "confidence": 0.1}),
            )
        })
        .collect();
    let mut e = entry("big", "2026-11-13T10:00:00Z");
    e["run"] = json!({"state": "s".repeat(200 * 1024), "questions": questions});
    e["reply"] = json!({"answers": answers, "model": "m", "inputTokens": 3});
    assert!(e.to_string().len() > 200 * 1024);
    let res = put(&app, "/api/history/big", &e, Some(&ada)).await;
    assert_eq!(res.status(), 204, "{}", res.text().await.unwrap());
}

#[tokio::test]
async fn a_setup_with_a_20000_character_situation_is_kept() {
    let (app, ada, _) = two_users().await;
    let mut s = setup("s1", "Long");
    s["sampleState"] = json!("x".repeat(20_000));
    assert_eq!(put(&app, "/api/setups/s1", &s, Some(&ada)).await.status(), 204);
}
