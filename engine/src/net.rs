//! The connection to the server: plain TCP for `rtmp://`, and TLS through Windows' own library
//! (SChannel, so Windows' list of trusted sites and its updates apply) for `rtmps://`.

use crate::error::{Error, Result};
use crate::rtmp::{Duplex, RtmpUrl};
use native_tls::{Certificate, Protocol, TlsConnector, TlsStream};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const CONNECT_WAIT: Duration = Duration::from_secs(10);
/// A write that makes no progress for this long means the connection is dead.
const WRITE_WAIT: Duration = Duration::from_secs(15);

pub enum Connection {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl Connection {
    fn tcp(&self) -> &TcpStream {
        match self {
            Connection::Plain(s) => s,
            Connection::Tls(s) => s.get_ref(),
        }
    }
}

impl Read for Connection {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Connection::Plain(s) => s.read(buf),
            Connection::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Connection {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Connection::Plain(s) => s.write(buf),
            Connection::Tls(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Connection::Plain(s) => s.flush(),
            Connection::Tls(s) => s.flush(),
        }
    }
}

impl Duplex for Connection {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> std::io::Result<()> {
        self.tcp().set_read_timeout(timeout)
    }
}

/// Opens the connection to `url`'s server. For tests only, `UNCBOX_STREAM_TLS_ROOT` may name a
/// certificate file (.cer or .pem) to trust in addition to Windows' own list, so a local test
/// server with its own certificate can be used; it is not set in normal use.
pub fn connect(url: &RtmpUrl) -> Result<Connection> {
    let addrs: Vec<_> = (url.host.as_str(), url.port)
        .to_socket_addrs()
        .map_err(|_| Error::new(format!("Couldn't find the server {}. Check the internet connection.", url.host)))?
        .collect();
    let mut last = None;
    let mut tcp = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_WAIT) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let tcp = tcp.ok_or_else(|| match last {
        Some(e) if e.kind() == std::io::ErrorKind::TimedOut => Error::new(format!("The server {} didn't answer.", url.host)),
        Some(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Error::new(format!("The server {} refused the connection.", url.host)),
        Some(e) => Error::new(format!("Couldn't connect to {}: {}", url.host, Error::from(e))),
        None => Error::new(format!("Couldn't find the server {}.", url.host)),
    })?;
    tcp.set_nodelay(true)?;
    tcp.set_write_timeout(Some(WRITE_WAIT))?;
    if !url.tls {
        return Ok(Connection::Plain(tcp));
    }
    let mut builder = TlsConnector::builder();
    builder.min_protocol_version(Some(Protocol::Tlsv12));
    // A test-only extra certificate, honoured only for a server on this PC: trusted for any host it
    // would let someone who can set this variable read the stream key on its way to Twitch.
    if let Some(path) = std::env::var("UNCBOX_STREAM_TLS_ROOT").ok().filter(|_| is_loopback(&url.host)) {
        crate::log::debug("Trusting the extra test certificate for this local server.");
        let bytes = std::fs::read(&path).map_err(|_| Error::new("The extra test certificate couldn't be read."))?;
        let cert = Certificate::from_der(&bytes)
            .or_else(|_| Certificate::from_pem(&bytes))
            .map_err(|_| Error::new("The extra test certificate isn't one Uncbox can read."))?;
        builder.add_root_certificate(cert);
    }
    let connector = builder.build().map_err(|_| Error::new("Windows' secure connection library couldn't start."))?;
    tcp.set_read_timeout(Some(CONNECT_WAIT))?;
    let tls =
        connector.connect(&url.host, tcp).map_err(|e| Error::new(format!("The secure connection to {} failed ({}).", url.host, short(&e.to_string()))))?;
    Ok(Connection::Tls(Box::new(tls)))
}

/// Whether a host is this PC (the only place the test certificate is trusted for).
pub fn is_loopback(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn short(text: &str) -> String {
    // Windows ends its own sentences with " (os error N)", which is no use to a person.
    let text = text.split(" (os error").next().unwrap_or(text);
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::is_loopback;

    #[test]
    fn the_test_certificate_is_only_for_this_pc() {
        for host in ["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "::1", "[::1]"] {
            assert!(is_loopback(host), "{host}");
        }
        for host in ["live.twitch.tv", "127.0.0.1.example.com", "localhost.example.com", "10.0.0.1", "0.0.0.0", ""] {
            assert!(!is_loopback(host), "{host}");
        }
    }
}
