use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{FromFnLayer, Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};

use super::ClientIp;

#[derive(Clone)]
pub struct Buckets {
    per_second: f64,
    burst: f64,
    state: Arc<Mutex<HashMap<IpAddr, (f64, Instant)>>>,
}

/// The address a limit counts by: one IPv6 client usually controls a whole /64, so the /64 is one
/// client; an IPv4 address (also one mapped into IPv6) is itself.
pub fn client_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) if v6.to_ipv4_mapped().is_some() => ip,
        IpAddr::V6(v6) => IpAddr::V6((u128::from(v6) & !(u128::MAX >> 64)).into()),
        v4 => v4,
    }
}

impl Buckets {
    fn take(&self, ip: IpAddr) -> bool {
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
        let (tokens, last) = map.entry(client_key(ip)).or_insert((self.burst, now));
        *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * self.per_second).min(self.burst);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

async fn limit(axum::extract::State(b): axum::extract::State<Buckets>, req: Request, next: Next) -> Response {
    let ip = req.extensions().get::<ClientIp>().map(|c| c.0);
    match ip {
        Some(ip) if !b.take(ip) => {
            (StatusCode::TOO_MANY_REQUESTS, "Too many attempts. Wait a minute and try again.").into_response()
        }
        _ => next.run(req).await,
    }
}

type RateLayer = FromFnLayer<
    fn(
        axum::extract::State<Buckets>,
        Request,
        Next,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Response> + Send>>,
    Buckets,
    (axum::extract::State<Buckets>, Request),
>;

/// A per-client token bucket: `per_minute` sustained, `burst` at once.
pub fn rate_limit(per_minute: u32, burst: u32) -> RateLayer {
    let b = Buckets { per_second: f64::from(per_minute) / 60.0, burst: f64::from(burst), state: Arc::default() };
    from_fn_with_state(b, |s, r, n| Box::pin(limit(s, r, n)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn buckets(burst: u32) -> Buckets {
        Buckets { per_second: 0.0, burst: f64::from(burst), state: Arc::default() }
    }

    #[test]
    fn one_ipv6_64_shares_a_bucket() {
        let b = buckets(2);
        assert!(b.take("2001:db8:1:2::1".parse().unwrap()));
        assert!(b.take("2001:db8:1:2:ffff:ffff:ffff:ffff".parse().unwrap()));
        assert!(!b.take("2001:db8:1:2:abcd::9".parse().unwrap()));
        // The next /64 is another client.
        assert!(b.take("2001:db8:1:3::1".parse().unwrap()));
    }

    #[test]
    fn ipv4_addresses_keep_their_own_buckets() {
        let b = buckets(1);
        assert!(b.take("192.0.2.1".parse().unwrap()));
        assert!(b.take("192.0.2.2".parse().unwrap()));
        assert!(!b.take("192.0.2.1".parse().unwrap()));
        assert_eq!(client_key("::ffff:192.0.2.1".parse().unwrap()), "::ffff:192.0.2.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn client_key_keeps_the_upper_64_bits() {
        assert_eq!(client_key("2001:db8:1:2:3:4:5:6".parse().unwrap()), "2001:db8:1:2::".parse::<IpAddr>().unwrap());
    }
}
