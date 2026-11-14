//! A token bucket per key: `per_minute` tokens refill evenly over a minute; the burst equals `per_minute`
//! unless given.

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
        Self::with_burst(per_minute, per_minute)
    }

    pub fn with_burst(per_minute: u32, burst: u32) -> Self {
        Self { per_second: f64::from(per_minute) / 60.0, burst: f64::from(burst), state: Arc::default() }
    }

    /// Takes one token for `key`; false when the bucket is empty.
    pub fn take(&self, key: &str) -> bool {
        // The guarded code leaves the map consistent even if it panics, so a poisoned lock keeps limiting.
        let mut map = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_poisoned_lock_keeps_limiting() {
        let limiter = Limiter::new(1);
        let state = limiter.state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = state.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        assert!(limiter.state.is_poisoned());
        assert!(limiter.take("a"));
        assert!(!limiter.take("a"));
    }
}
