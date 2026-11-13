//! A token bucket per key: `per_minute` tokens refill evenly over a minute; the burst equals `per_minute`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone)]
pub struct Limiter {
    per_second: f64,
    burst: f64,
    state: Arc<Mutex<HashMap<String, (f64, Instant)>>>,
}

impl Limiter {
    pub fn new(per_minute: u32) -> Self {
        let burst = f64::from(per_minute);
        Self { per_second: burst / 60.0, burst, state: Arc::default() }
    }

    /// Takes one token for `key`; false when the bucket is empty.
    pub fn take(&self, key: &str) -> bool {
        let Ok(mut map) = self.state.lock() else {
            return true;
        };
        let now = Instant::now();
        if map.len() > 10_000 {
            // A bucket that has refilled carries no state, so it can go.
            let (rate, burst) = (self.per_second, self.burst);
            map.retain(|_, (tokens, t)| *tokens + now.duration_since(*t).as_secs_f64() * rate < burst);
            if map.len() > 100_000 {
                map.clear();
            }
        }
        let entry = map.entry(key.to_owned()).or_insert((self.burst, now));
        let refilled = (entry.0 + now.duration_since(entry.1).as_secs_f64() * self.per_second).min(self.burst);
        entry.1 = now;
        if refilled >= 1.0 {
            entry.0 = refilled - 1.0;
            true
        } else {
            entry.0 = refilled;
            false
        }
    }
}
