//! Model preheat: one minimal request now and then, so a local model is loaded before the first
//! real question.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::systemone::Run;

/// The cooldown is for the whole server, not per caller: one warm model is warm for everyone.
#[derive(Debug, Default)]
pub struct Preheat {
    since: Mutex<Option<Instant>>,
}

impl Preheat {
    pub const COOLDOWN: Duration = Duration::from_secs(60);

    pub fn new() -> Self {
        Self::default()
    }

    /// True, and the cooldown starts at `now`, when none is running.
    pub fn take(&self, now: Instant) -> bool {
        let mut since = self.since.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if since.is_some_and(|start| now.saturating_duration_since(start) < Self::COOLDOWN) {
            return false;
        }
        *since = Some(now);
        true
    }

    /// A real run keeps the model warm, so it starts the cooldown too.
    pub fn touch(&self, now: Instant) {
        *self.since.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(now);
    }
}

/// The smallest run the endpoint answers: built like a posted run, so it cannot drift from what the
/// server accepts. The input is fixed, and a unit test runs this, so the panics cannot happen later.
#[allow(clippy::expect_used)]
pub fn warm_up_run() -> Run {
    let run: Run = serde_json::from_value(json!({
        "state": "ping",
        "questions": [{ "key": "ready", "type": "noul", "text": "Ready?" }]
    }))
    .expect("the warm-up run has the shape of a posted run");
    run.validate().expect("the warm-up run passes the validation of a posted run");
    run
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::systemone::{Kind, request_json};

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn take_is_true_at_first_and_again_after_the_cooldown() {
        let p = Preheat::new();
        let t0 = Instant::now();
        assert!(p.take(t0));
        assert!(!p.take(t0 + secs(59)));
        assert!(p.take(t0 + secs(60)));
    }

    #[test]
    fn touch_starts_the_cooldown() {
        let p = Preheat::new();
        let t0 = Instant::now();
        p.touch(t0);
        assert!(!p.take(t0));
        assert!(p.take(t0 + secs(60)));
    }

    #[test]
    fn the_warm_up_run_is_one_yes_or_no_question() {
        let run = warm_up_run();
        assert_eq!(run.questions.len(), 1);
        assert_eq!(run.questions[0].kind, Kind::Noul);
        assert!(request_json(&run, "m").contains("\"ready\""));
    }
}
