//! Builds System One requests and reads the answers. Mirrors `web/js/systemone.js`; the shared
//! cases are in `fixtures/systemone`.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::error::AppError;

const MAX_QUESTIONS: usize = 8;
const MAX_QUESTION_TEXT: usize = 500;
const MAX_KEY: usize = 30;
const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 8;
const MAX_OPTION_NAME: usize = 40;
const MAX_DESCRIPTION: usize = 200;
const MIN_LEVELS: usize = 2;
const MAX_LEVELS: usize = 10;
const MAX_LEVEL: usize = 200;
const MAX_STATE: usize = 8000;

const BAD_ANSWER: &str = "The model endpoint sent an answer this app does not understand.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Choice,
    Score,
    Noul,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Opt {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Level {
    #[serde(default)]
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub text: String,
    #[serde(default)]
    pub options: Vec<Opt>,
    #[serde(default)]
    pub levels: Vec<Level>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub state: String,
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub answers: Map<String, Value>,
    pub model: String,
    pub input_tokens: u64,
}

/// Trims like JavaScript's `String.prototype.trim` (ECMAScript WhiteSpace and LineTerminator),
/// which differs from `str::trim` at U+FEFF and U+0085.
fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// ECMAScript WhiteSpace and LineTerminator.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{D}'
            | '\u{20}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// The words of `s` as the page counts them: runs between JavaScript whitespace.
pub fn word_count(s: &str) -> usize {
    s.split(is_js_space).filter(|w| !w.is_empty()).count()
}

fn len(s: &str) -> usize {
    s.chars().count()
}

fn invalid(sentence: impl Into<String>) -> Result<(), AppError> {
    Err(AppError::Invalid(sentence.into()))
}

impl Run {
    /// The first problem wins: run-level checks, then each question in order with its own
    /// checks in list order.
    pub fn validate(&self) -> Result<(), AppError> {
        self.validate_questions(false)
    }

    /// `validate`, optionally allowing a question with no text (a saved setup may keep one).
    pub fn validate_questions(&self, allow_empty_text: bool) -> Result<(), AppError> {
        let count = self.questions.len();
        if count < 1 {
            return invalid("Add at least one question.");
        }
        if count > MAX_QUESTIONS {
            return invalid(format!("Use at most {MAX_QUESTIONS} questions."));
        }
        if len(&self.state) > MAX_STATE {
            return invalid("Shorten the situation to 8,000 characters or fewer.");
        }
        let mut seen = HashSet::new();
        if !self.questions.iter().all(|q| seen.insert(q.key.as_str())) {
            return invalid("Name each question differently.");
        }
        let key_ok = |k: &str| {
            let n = len(k);
            (1..=MAX_KEY).contains(&n) && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        };
        if !self.questions.iter().all(|q| key_ok(&q.key)) {
            return invalid("Name each question with 1 to 30 lower-case letters, digits or _.");
        }
        self.questions.iter().try_for_each(|q| q.validate(allow_empty_text))
    }
}

impl Question {
    fn validate(&self, allow_empty_text: bool) -> Result<(), AppError> {
        let text = trim(&self.text);
        if text.is_empty() && !allow_empty_text {
            return invalid("Type a question first.");
        }
        if len(text) > MAX_QUESTION_TEXT {
            return invalid("Keep each question to 500 characters or fewer.");
        }
        match self.kind {
            Kind::Choice => self.validate_options(),
            Kind::Score => self.validate_levels(),
            Kind::Noul => Ok(()),
        }
    }

    fn validate_options(&self) -> Result<(), AppError> {
        let options = &self.options;
        if options.len() < MIN_OPTIONS {
            return invalid(format!("Add at least {MIN_OPTIONS} options."));
        }
        if options.len() > MAX_OPTIONS {
            return invalid(format!("Use at most {MAX_OPTIONS} options."));
        }
        let names: Vec<&str> = options.iter().map(|o| trim(&o.name)).collect();
        if names.iter().any(|n| n.is_empty()) {
            return invalid("Name every option.");
        }
        if names.iter().any(|n| len(n) > MAX_OPTION_NAME) {
            return invalid("Keep each option to 40 characters or fewer.");
        }
        if options.iter().any(|o| len(trim(&o.description)) > MAX_DESCRIPTION) {
            return invalid("Keep each description to 200 characters or fewer.");
        }
        let mut seen = HashSet::new();
        for n in names {
            if !seen.insert(n) {
                return invalid(format!("Use each option only once: \"{n}\"."));
            }
        }
        Ok(())
    }

    fn validate_levels(&self) -> Result<(), AppError> {
        let levels = &self.levels;
        if levels.len() < MIN_LEVELS {
            return invalid(format!("Add at least {MIN_LEVELS} levels."));
        }
        if levels.len() > MAX_LEVELS {
            return invalid(format!("Use at most {MAX_LEVELS} levels."));
        }
        let texts: Vec<&str> = levels.iter().map(|l| trim(&l.text)).collect();
        if texts.iter().any(|t| t.is_empty()) {
            return invalid("Describe every level.");
        }
        if texts.iter().any(|t| len(t) > MAX_LEVEL) {
            return invalid("Keep each level to 200 characters or fewer.");
        }
        Ok(())
    }
}

/// JSON string literal. serde_json escapes the same characters as `JSON.stringify`.
fn json_str(s: &str) -> String {
    Value::String(s.to_owned()).to_string()
}

/// The exact request body text: compact, keys in a fixed order, choice criteria written entry by
/// entry so integer-like names are not reordered by a JSON object model.
pub fn request_json(run: &Run, model: &str) -> String {
    let questions: Vec<String> = run
        .questions
        .iter()
        .map(|q| {
            let kind = match q.kind {
                Kind::Choice => "choice",
                Kind::Score => "score",
                Kind::Noul => "noul",
            };
            let mut out = format!(
                "{}:{{\"type\":{},\"instructions\":{}",
                json_str(&q.key),
                json_str(kind),
                json_str(trim(&q.text))
            );
            match q.kind {
                Kind::Choice => {
                    let entries: Vec<String> = q
                        .options
                        .iter()
                        .map(|o| {
                            let name = trim(&o.name);
                            let description = trim(&o.description);
                            let description = if description.is_empty() { name } else { description };
                            format!("{}:{}", json_str(name), json_str(description))
                        })
                        .collect();
                    out.push_str(&format!(",\"criteria\":{{{}}}", entries.join(",")));
                }
                Kind::Score => {
                    let levels: Vec<String> = q.levels.iter().map(|l| json_str(trim(&l.text))).collect();
                    out.push_str(&format!(",\"criteria\":[{}]", levels.join(",")));
                }
                Kind::Noul => {}
            }
            out.push('}');
            out
        })
        .collect();
    format!(
        "{{\"model\":{},\"state\":{},\"questions\":{{{}}}}}",
        json_str(model),
        json_str(&run.state),
        questions.join(",")
    )
}

fn bad_answer() -> AppError {
    AppError::Upstream(BAD_ANSWER.to_owned())
}

fn number(v: Option<&Value>) -> Result<Number, AppError> {
    match v {
        Some(Value::Number(n)) => Ok(n.clone()),
        _ => Err(bad_answer()),
    }
}

fn probabilities(answer: &Map<String, Value>, names: &[String]) -> Result<Value, AppError> {
    let Some(Value::Object(table)) = answer.get("probabilities") else {
        return Err(bad_answer());
    };
    let list = names.iter().map(|n| number(table.get(n)).map(Value::Number)).collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(list))
}

/// Reads the parsed upstream body into an Outcome; probabilities are ordered by option position or
/// level index (the endpoint sorts a choice's probabilities by name).
pub fn parse_response(body: Option<&Value>, run: &Run) -> Result<Outcome, AppError> {
    let Some(Value::Object(body)) = body else {
        return Err(bad_answer());
    };
    let Some(Value::Object(upstream)) = body.get("answers") else {
        return Err(bad_answer());
    };
    let mut answers = Map::new();
    for q in &run.questions {
        let Some(Value::Object(a)) = upstream.get(&q.key) else {
            return Err(bad_answer());
        };
        let kind = match q.kind {
            Kind::Choice => "choice",
            Kind::Score => "score",
            Kind::Noul => "noul",
        };
        if a.get("type").and_then(Value::as_str) != Some(kind) {
            return Err(bad_answer());
        }
        let mut out = Map::new();
        out.insert("type".to_owned(), Value::String(kind.to_owned()));
        match q.kind {
            Kind::Choice => {
                let names: Vec<String> = q.options.iter().map(|o| trim(&o.name).to_owned()).collect();
                let choice = match a.get("choice") {
                    Some(Value::String(c)) if names.contains(c) => c.clone(),
                    _ => return Err(bad_answer()),
                };
                out.insert("choice".to_owned(), Value::String(choice));
                out.insert("probabilities".to_owned(), probabilities(a, &names)?);
                out.insert("confidence".to_owned(), Value::Number(number(a.get("confidence"))?));
            }
            Kind::Score => {
                out.insert("score".to_owned(), Value::Number(number(a.get("score"))?));
                let indexes: Vec<String> = (0..q.levels.len()).map(|i| i.to_string()).collect();
                out.insert("probabilities".to_owned(), probabilities(a, &indexes)?);
                out.insert("confidence".to_owned(), Value::Number(number(a.get("confidence"))?));
            }
            Kind::Noul => {
                out.insert("noul".to_owned(), Value::Number(number(a.get("noul"))?));
            }
        }
        answers.insert(q.key.clone(), Value::Object(out));
    }
    let model = body.get("model").and_then(Value::as_str).unwrap_or_default().to_owned();
    let input_tokens = body
        .get("usage")
        .and_then(|u| u.get("input_tokens"))
        .and_then(Value::as_number)
        .and_then(|n| n.as_u64().or_else(|| n.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)))
        .unwrap_or(0);
    Ok(Outcome { answers, model, input_tokens })
}

#[cfg(test)]
mod word_tests {
    use super::word_count;

    #[test]
    fn words_are_counted_like_javascript_splits_them() {
        assert_eq!(word_count(""), 0);
        assert_eq!(word_count(" \n\t "), 0);
        assert_eq!(word_count("We are four people, one is vegetarian, and it is raining."), 11);
        assert_eq!(word_count("  a  b\nc\u{A0}d "), 4);
        assert_eq!(word_count("a\u{FEFF}b"), 2);
        assert_eq!(word_count("a\u{85}b"), 1);
    }
}
