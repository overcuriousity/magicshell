//! systemd notification (`Type=notify`) without a library: one datagram to the socket systemd
//! names in `NOTIFY_SOCKET`. Without that variable (not started by systemd) nothing is sent.

use std::ffi::OsStr;
use std::os::unix::net::{SocketAddr, UnixDatagram};
use std::time::Duration;

/// Tells systemd the service is up: `systemctl start` returns only now, and fails if the
/// process exits first. A failure is logged, never fatal.
pub fn ready() {
    send("READY=1");
}

/// With `WatchdogSec=` in the unit, a heartbeat at half the interval systemd asks for; a
/// runtime that stops running tasks misses it and systemd restarts the service.
pub fn watchdog() {
    let Some(interval) = watchdog_interval(
        std::env::var("WATCHDOG_USEC").ok().as_deref(),
        std::env::var("WATCHDOG_PID").ok().as_deref(),
        std::process::id(),
    ) else {
        return;
    };
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(interval);
        loop {
            tick.tick().await;
            send("WATCHDOG=1");
        }
    });
}

/// Half of `WATCHDOG_USEC`, when it is meant for this process.
fn watchdog_interval(usec: Option<&str>, pid: Option<&str>, me: u32) -> Option<Duration> {
    let usec: u64 = usec?.parse().ok().filter(|&u| u > 0)?;
    if let Some(pid) = pid
        && pid.parse::<u32>().ok() != Some(me)
    {
        return None;
    }
    Some(Duration::from_micros(usec / 2))
}

fn send(state: &str) {
    if let Some(socket) = std::env::var_os("NOTIFY_SOCKET")
        && let Err(e) = notify(&socket, state)
    {
        tracing::warn!(error = %e, state, "sd_notify failed");
    }
}

fn notify(socket: &OsStr, state: &str) -> std::io::Result<()> {
    let sock = UnixDatagram::unbound()?;
    // "@name" is a socket in the abstract namespace.
    if let Some(name) = socket.as_encoded_bytes().strip_prefix(b"@") {
        use std::os::linux::net::SocketAddrExt;
        sock.send_to_addr(state.as_bytes(), &SocketAddr::from_abstract_name(name)?)?;
    } else {
        sock.send_to(state.as_bytes(), socket)?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn recv(rx: &UnixDatagram) -> Vec<u8> {
        let mut buf = [0u8; 64];
        let n = rx.recv(&mut buf).unwrap();
        buf[..n].to_vec()
    }

    #[test]
    fn sends_to_a_path_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notify");
        let rx = UnixDatagram::bind(&path).unwrap();
        notify(path.as_os_str(), "READY=1").unwrap();
        assert_eq!(recv(&rx), b"READY=1");
    }

    #[test]
    fn sends_to_an_abstract_socket() {
        use std::os::linux::net::SocketAddrExt;
        let name = format!("magicshell-test-{}", std::process::id());
        let rx = UnixDatagram::bind_addr(&SocketAddr::from_abstract_name(&name).unwrap()).unwrap();
        notify(OsStr::new(&format!("@{name}")), "READY=1").unwrap();
        assert_eq!(recv(&rx), b"READY=1");
    }

    #[test]
    fn the_heartbeat_is_half_the_interval_and_only_for_this_process() {
        assert_eq!(watchdog_interval(Some("30000000"), None, 7), Some(Duration::from_secs(15)));
        assert_eq!(watchdog_interval(Some("30000000"), Some("7"), 7), Some(Duration::from_secs(15)));
        assert_eq!(watchdog_interval(Some("30000000"), Some("8"), 7), None);
        assert_eq!(watchdog_interval(Some("0"), None, 7), None);
        assert_eq!(watchdog_interval(Some("soon"), None, 7), None);
        assert_eq!(watchdog_interval(None, None, 7), None);
    }
}
