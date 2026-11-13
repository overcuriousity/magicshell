use std::net::{IpAddr, SocketAddr};

use axum::extract::connect_info::MockConnectInfo;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use ipnet::IpNet;

use crate::kit::error::OcError;

/// The client address: the TCP peer, or the right-most untrusted `X-Forwarded-For` hop when the peer is a trusted proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientIp(pub IpAddr);

fn peer(parts: &Parts) -> Option<IpAddr> {
    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .or_else(|| parts.extensions.get::<MockConnectInfo<SocketAddr>>().map(|c| c.0.ip()))
}

pub(super) fn resolve(parts: &Parts, proxies: &[IpNet]) -> Option<IpAddr> {
    let peer = peer(parts)?;
    let trusted = |ip: &IpAddr| proxies.iter().any(|n| n.contains(ip));
    if !trusted(&peer) {
        return Some(peer);
    }
    let forwarded = parts
        .headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|s| s.trim().parse::<IpAddr>().ok())
        .collect::<Vec<_>>();
    Some(forwarded.into_iter().rev().find(|ip| !trusted(ip)).unwrap_or(peer))
}

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = OcError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<ClientIp>()
            .copied()
            .ok_or_else(|| OcError::Internal("ClientIp requires the oc security layer and ConnectInfo.".into()))
    }
}
