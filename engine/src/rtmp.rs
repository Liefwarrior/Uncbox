//! RTMP, the way a stream gets to Twitch: a handshake, then messages cut into chunks, with a few
//! commands (connect, createStream, publish) in AMF0 before the sound and picture start.
//!
//! This is the publishing half only. The pieces are separate so each can be tested on its own:
//! [`RtmpUrl`], the handshake bytes, [`ChunkWriter`] (messages into chunks), [`ChunkReader`]
//! (bytes from the server into messages, however they arrive) and [`Publisher`], which runs the
//! conversation over any stream that reads and writes.

use crate::amf0::{self, Value};
use crate::bail;
use crate::error::{Error, Result};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::time::{Duration, Instant};

pub const MSG_SET_CHUNK_SIZE: u8 = 1;
pub const MSG_ABORT: u8 = 2;
pub const MSG_ACK: u8 = 3;
pub const MSG_USER_CONTROL: u8 = 4;
pub const MSG_WINDOW_ACK_SIZE: u8 = 5;
pub const MSG_SET_PEER_BANDWIDTH: u8 = 6;
pub const MSG_AUDIO: u8 = 8;
pub const MSG_VIDEO: u8 = 9;
pub const MSG_DATA_AMF0: u8 = 18;
pub const MSG_COMMAND_AMF0: u8 = 20;

/// The chunk size Uncbox sends with: big enough that a keyframe is a few chunks rather than hundreds.
pub const OUR_CHUNK_SIZE: usize = 4096;
const DEFAULT_CHUNK_SIZE: usize = 128;
const DEFAULT_WINDOW: u32 = 2_500_000;
/// Chunk streams: 2 is for protocol control, the others are ours.
const CSID_CONTROL: u32 = 2;
const CSID_COMMAND: u32 = 3;
const CSID_DATA: u32 = 4;
const CSID_AUDIO: u32 = 5;
const CSID_VIDEO: u32 = 6;
const ANSWER_WAIT: Duration = Duration::from_secs(10);

// ---- the address ----

/// `rtmp://host[:port]/app/stream` or `rtmps://…` (TLS, port 443 unless given).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtmpUrl {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    pub app: String,
    /// The stream key, with any `?query` it carries (a Twitch test stream adds `?bandwidthtest=true`).
    pub stream: String,
}

impl RtmpUrl {
    pub fn parse(url: &str) -> Result<RtmpUrl> {
        let (tls, rest) = if let Some(rest) = url.strip_prefix("rtmps://") {
            (true, rest)
        } else if let Some(rest) = url.strip_prefix("rtmp://") {
            (false, rest)
        } else {
            bail!("The stream address has to start with rtmp:// or rtmps://.");
        };
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) if !host.ends_with(']') || host.starts_with('[') => {
                let port: u16 = port.parse().map_err(|_| Error::new("The stream address has a port that isn't a number."))?;
                (host, port)
            }
            _ => (authority, if tls { 443 } else { 1935 }),
        };
        let host = host.trim_matches(|c| c == '[' || c == ']');
        if host.is_empty() {
            bail!("The stream address has no server name.");
        }
        let (app, stream) = path.split_once('/').unwrap_or((path, ""));
        if app.is_empty() || stream.is_empty() {
            bail!("The stream address is missing its stream key.");
        }
        Ok(RtmpUrl { tls, host: host.to_string(), port, app: app.to_string(), stream: stream.to_string() })
    }

    /// What goes in the `tcUrl` of the connect command: the address without the stream key.
    pub fn tc_url(&self) -> String {
        format!("{}://{}:{}/{}", if self.tls { "rtmps" } else { "rtmp" }, self.host, self.port, self.app)
    }
}

// ---- the handshake ----

pub const HANDSHAKE_SIZE: usize = 1536;

/// Fills `buf` with pseudo-random bytes (the handshake only wants them unpredictable enough to
/// tell connections apart, not secret).
pub fn fill_random(buf: &mut [u8], mut seed: u64) {
    seed |= 1;
    for b in buf.iter_mut() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        *b = (seed >> 24) as u8;
    }
}

/// C0 (the version, 3) followed by C1: a time, four zero bytes, and 1528 random ones.
pub fn client_hello(epoch_ms: u32, seed: u64) -> Vec<u8> {
    let mut out = vec![0u8; 1 + HANDSHAKE_SIZE];
    out[0] = 3;
    out[1..5].copy_from_slice(&epoch_ms.to_be_bytes());
    fill_random(&mut out[9..], seed);
    out
}

/// C2: the server's S1 echoed back, with the time we read it in the second time field.
pub fn client_reply(s1: &[u8], read_at_ms: u32) -> Result<Vec<u8>> {
    if s1.len() != HANDSHAKE_SIZE {
        bail!("The server's handshake was the wrong size.");
    }
    let mut c2 = s1.to_vec();
    c2[4..8].copy_from_slice(&read_at_ms.to_be_bytes());
    Ok(c2)
}

// ---- messages and chunks ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub timestamp: u32,
    pub type_id: u8,
    pub stream_id: u32,
    pub payload: Vec<u8>,
}

#[derive(Clone, Copy, Default)]
struct Sent {
    timestamp: u32,
    length: usize,
    type_id: u8,
    stream_id: u32,
}

/// Cuts messages into chunks. The first message on a chunk stream carries everything in full
/// (format 0); later ones only what changed since the last: the time since it (format 1, or 2 when
/// the length and type are the same too), and the pieces of a long message after its first chunk
/// carry just the one-byte header (format 3).
pub struct ChunkWriter {
    chunk_size: usize,
    sent: HashMap<u32, Sent>,
}

impl Default for ChunkWriter {
    fn default() -> Self {
        ChunkWriter { chunk_size: DEFAULT_CHUNK_SIZE, sent: HashMap::new() }
    }
}

fn basic_header(out: &mut Vec<u8>, format: u8, csid: u32) {
    match csid {
        2..=63 => out.push(format << 6 | csid as u8),
        64..=319 => out.extend_from_slice(&[format << 6, (csid - 64) as u8]),
        _ => out.extend_from_slice(&[format << 6 | 1, ((csid - 64) & 0xFF) as u8, ((csid - 64) >> 8) as u8]),
    }
}

fn u24(out: &mut Vec<u8>, n: u32) {
    out.extend_from_slice(&n.to_be_bytes()[1..4]);
}

impl ChunkWriter {
    pub fn chunk_size(&self) -> usize {
        self.chunk_size
    }

    /// From now on messages are cut at this size (after telling the server with a Set Chunk Size message).
    pub fn set_chunk_size(&mut self, size: usize) {
        self.chunk_size = size.clamp(1, 0x7FFF_FFFF);
    }

    /// Appends the chunks of `msg` on chunk stream `csid` to `out`.
    pub fn write(&mut self, csid: u32, msg: &Message, out: &mut Vec<u8>) {
        let prev = self.sent.get(&csid).copied();
        let len = msg.payload.len();
        let (format, field) = match prev {
            Some(p) if p.stream_id == msg.stream_id && msg.timestamp >= p.timestamp => {
                let delta = msg.timestamp - p.timestamp;
                if p.length == len && p.type_id == msg.type_id {
                    (2, delta)
                } else {
                    (1, delta)
                }
            }
            _ => (0, msg.timestamp),
        };
        let extended = field >= 0xFF_FFFF;

        basic_header(out, format, csid);
        u24(out, if extended { 0xFF_FFFF } else { field });
        if format <= 1 {
            u24(out, len as u32);
            out.push(msg.type_id);
        }
        if format == 0 {
            out.extend_from_slice(&msg.stream_id.to_le_bytes());
        }
        if extended {
            out.extend_from_slice(&field.to_be_bytes());
        }

        let mut rest = &msg.payload[..];
        let first = rest.len().min(self.chunk_size);
        out.extend_from_slice(&rest[..first]);
        rest = &rest[first..];
        while !rest.is_empty() {
            basic_header(out, 3, csid);
            if extended {
                out.extend_from_slice(&field.to_be_bytes());
            }
            let n = rest.len().min(self.chunk_size);
            out.extend_from_slice(&rest[..n]);
            rest = &rest[n..];
        }
        self.sent.insert(csid, Sent { timestamp: msg.timestamp, length: len, type_id: msg.type_id, stream_id: msg.stream_id });
    }
}

#[derive(Default)]
struct Incoming {
    timestamp: u32,
    delta: u32,
    length: usize,
    type_id: u8,
    stream_id: u32,
    extended: bool,
    payload: Vec<u8>,
}

/// Puts bytes from the server back together into messages. Bytes can arrive in any pieces: feed
/// them to [`ChunkReader::push`] as they come, and whole messages come out.
pub struct ChunkReader {
    chunk_size: usize,
    pending: Vec<u8>,
    streams: HashMap<u32, Incoming>,
    /// Every byte pushed so far, which the server wants acknowledged.
    pub bytes_received: u64,
}

impl Default for ChunkReader {
    fn default() -> Self {
        ChunkReader { chunk_size: DEFAULT_CHUNK_SIZE, pending: Vec::new(), streams: HashMap::new(), bytes_received: 0 }
    }
}

impl ChunkReader {
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<Message>> {
        self.bytes_received += data.len() as u64;
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(data);
        let mut done = Vec::new();
        let mut at = 0;
        let outcome = loop {
            match self.chunk(&buf[at..]) {
                Ok(Some((used, message))) => {
                    at += used;
                    if let Some(msg) = message {
                        self.apply_control(&msg);
                        done.push(msg);
                    }
                }
                Ok(None) => break Ok(()),
                Err(e) => break Err(e),
            }
        };
        buf.drain(..at);
        self.pending = buf;
        outcome.map(|()| done)
    }

    /// The few messages that change how the rest of the bytes are read.
    fn apply_control(&mut self, msg: &Message) {
        let first_word = (msg.payload.len() >= 4).then(|| u32::from_be_bytes([msg.payload[0], msg.payload[1], msg.payload[2], msg.payload[3]]));
        match (msg.type_id, first_word) {
            (MSG_SET_CHUNK_SIZE, Some(size)) => self.chunk_size = (size & 0x7FFF_FFFF).max(1) as usize,
            (MSG_ABORT, Some(csid)) => {
                if let Some(s) = self.streams.get_mut(&csid) {
                    s.payload.clear();
                }
            }
            _ => {}
        }
    }

    /// Reads one chunk from the front of `buf`: how many bytes it used and the message it finished,
    /// if it was the last chunk of one; `None` when `buf` doesn't hold a whole chunk yet. Nothing is
    /// remembered until the whole chunk is there, so the same bytes can be offered again later.
    #[allow(clippy::type_complexity)]
    fn chunk(&mut self, buf: &[u8]) -> Result<Option<(usize, Option<Message>)>> {
        let Some(&first) = buf.first() else { return Ok(None) };
        let format = (first >> 6) as usize;
        let (csid, mut at) = match first & 0x3F {
            0 => match buf.get(1) {
                Some(&b) => (64 + u32::from(b), 2),
                None => return Ok(None),
            },
            1 => {
                if buf.len() < 3 {
                    return Ok(None);
                }
                (64 + u32::from(buf[1]) + u32::from(buf[2]) * 256, 3)
            }
            n => (u32::from(n), 1),
        };
        let header_len = [11, 7, 3, 0][format];
        if buf.len() < at + header_len {
            return Ok(None);
        }
        let head = &buf[at..at + header_len];
        at += header_len;
        let be24 = |b: &[u8]| u32::from_be_bytes([0, b[0], b[1], b[2]]);

        let (prev_len, prev_have, prev_extended) = self.streams.get(&csid).map_or((0, 0, false), |s| (s.length, s.payload.len(), s.extended));
        let field = (format <= 2).then(|| be24(&head[0..3]));
        let extended = field.map_or(prev_extended, |f| f == 0xFF_FFFF);
        let length = if format <= 1 { be24(&head[3..6]) as usize } else { prev_len };
        let mut value = field.unwrap_or(0);
        if extended {
            if buf.len() < at + 4 {
                return Ok(None);
            }
            value = u32::from_be_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
            at += 4;
        }
        if length > 16 * 1024 * 1024 {
            bail!("The server sent a message that was far too long.");
        }
        let take = (length - prev_have.min(length)).min(self.chunk_size);
        if buf.len() < at + take {
            return Ok(None);
        }

        // The whole chunk is here: now it can change what is remembered.
        let state = self.streams.entry(csid).or_default();
        let mid_message = !state.payload.is_empty();
        state.extended = extended;
        if format <= 1 {
            state.length = length;
            state.type_id = head[6];
        }
        if format == 0 {
            state.stream_id = u32::from_le_bytes([head[7], head[8], head[9], head[10]]);
        }
        if !mid_message {
            match format {
                0 => {
                    state.timestamp = value;
                    state.delta = 0;
                }
                1 | 2 => {
                    state.delta = value;
                    state.timestamp = state.timestamp.wrapping_add(value);
                }
                _ => state.timestamp = state.timestamp.wrapping_add(state.delta),
            }
        }
        state.payload.extend_from_slice(&buf[at..at + take]);
        at += take;

        let message = (state.payload.len() >= state.length).then(|| Message {
            timestamp: state.timestamp,
            type_id: state.type_id,
            stream_id: state.stream_id,
            payload: std::mem::take(&mut state.payload),
        });
        Ok(Some((at, message)))
    }
}

// ---- control messages ----

pub fn set_chunk_size_message(size: u32) -> Message {
    Message { timestamp: 0, type_id: MSG_SET_CHUNK_SIZE, stream_id: 0, payload: size.to_be_bytes().to_vec() }
}

pub fn ack_message(received: u32) -> Message {
    Message { timestamp: 0, type_id: MSG_ACK, stream_id: 0, payload: received.to_be_bytes().to_vec() }
}

pub fn window_ack_size_message(size: u32) -> Message {
    Message { timestamp: 0, type_id: MSG_WINDOW_ACK_SIZE, stream_id: 0, payload: size.to_be_bytes().to_vec() }
}

/// A user control message: an event type and its data (a ping answers with the time it came with).
pub fn user_control_message(event: u16, data: &[u8]) -> Message {
    let mut payload = event.to_be_bytes().to_vec();
    payload.extend_from_slice(data);
    Message { timestamp: 0, type_id: MSG_USER_CONTROL, stream_id: 0, payload }
}

fn command(name: &str, transaction: f64, args: &[Value], stream_id: u32) -> Message {
    let mut values = vec![Value::string(name), Value::Number(transaction)];
    values.extend_from_slice(args);
    Message { timestamp: 0, type_id: MSG_COMMAND_AMF0, stream_id, payload: amf0::encode(&values) }
}

/// The `connect` command, as the server expects it from a publishing client.
pub fn connect_message(url: &RtmpUrl) -> Message {
    command(
        "connect",
        1.0,
        &[Value::object(&[
            ("app", Value::String(url.app.clone())),
            ("type", Value::string("nonprivate")),
            ("flashVer", Value::string("FMLE/3.0 (compatible; Uncbox)")),
            ("tcUrl", Value::String(url.tc_url())),
        ])],
        0,
    )
}

// ---- the conversation ----

/// A stream that can also be told how long a read may wait (sockets and TLS streams can).
pub trait Duplex: Read + Write {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> std::io::Result<()>;
}

/// What the server said in an `onStatus` or `_error` that Uncbox may need to react to.
#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub level: String,
    pub code: String,
    pub description: String,
}

/// A stream publishing to a server: [`Publisher::open`] does the handshake and commands, then
/// audio, video and metadata go out with the `send_*` calls, and [`Publisher::poll`] is called every
/// so often to answer what the server says.
pub struct Publisher<S: Duplex> {
    io: S,
    writer: ChunkWriter,
    reader: ChunkReader,
    stream_id: u32,
    window: u32,
    acked: u64,
    sent: u64,
    scratch: Vec<u8>,
    read_buf: Vec<u8>,
    closed: bool,
}

fn is_timeout(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

/// A plain sentence for a status the server gave when it said no.
fn refusal(status: &Status) -> Error {
    let code = status.code.as_str();
    let text = if code.contains("BadName") || code.contains("Rejected") || code.contains("Unauthorized") {
        "The server turned the stream away. Check the stream key."
    } else if code.contains("Failed") {
        "The server couldn't start the stream."
    } else {
        "The server stopped the stream."
    };
    Error::new(format!("{text} ({})", if status.description.is_empty() { code } else { &status.description }))
}

impl<S: Duplex> Publisher<S> {
    /// Handshake, `connect`, `createStream` and `publish`, waiting for the server's yes at each step.
    pub fn open(mut io: S, url: &RtmpUrl, clock_ms: u32, seed: u64) -> Result<Self> {
        io.set_read_timeout(Some(ANSWER_WAIT))?;
        io.write_all(&client_hello(clock_ms, seed))?;
        io.flush()?;
        let mut reply = vec![0u8; 1 + 2 * HANDSHAKE_SIZE];
        io.read_exact(&mut reply).map_err(|e| {
            if e.kind() == ErrorKind::UnexpectedEof || is_timeout(e.kind()) {
                Error::new("The server hung up during the handshake. Check the stream address.")
            } else {
                Error::from(e)
            }
        })?;
        if reply[0] != 3 {
            bail!("That server doesn't speak RTMP.");
        }
        io.write_all(&client_reply(&reply[1..1 + HANDSHAKE_SIZE], clock_ms)?)?;

        let mut me = Publisher {
            io,
            writer: ChunkWriter::default(),
            reader: ChunkReader::default(),
            stream_id: 0,
            window: DEFAULT_WINDOW,
            acked: 0,
            sent: 0,
            scratch: Vec::with_capacity(64 * 1024),
            read_buf: vec![0u8; 16 * 1024],
            closed: false,
        };
        me.send(CSID_CONTROL, &set_chunk_size_message(OUR_CHUNK_SIZE as u32))?;
        me.writer.set_chunk_size(OUR_CHUNK_SIZE);

        me.send(CSID_COMMAND, &connect_message(url))?;
        let (_, ok) = me.wait_result(1.0)?;
        if ok.first().and_then(|v| v.get("code")).and_then(Value::as_str).is_some_and(|c| c.contains("Rejected") || c.contains("Failed")) {
            bail!("The server refused the connection.");
        }

        me.send(CSID_COMMAND, &command("releaseStream", 2.0, &[Value::Null, Value::string(&url.stream)], 0))?;
        me.send(CSID_COMMAND, &command("FCPublish", 3.0, &[Value::Null, Value::string(&url.stream)], 0))?;
        me.send(CSID_COMMAND, &command("createStream", 4.0, &[Value::Null], 0))?;
        let (_, made) = me.wait_result(4.0)?;
        me.stream_id = made.iter().find_map(Value::as_number).map(|n| n as u32).filter(|n| *n > 0).unwrap_or(1);

        me.send(CSID_DATA, &command("publish", 0.0, &[Value::Null, Value::string(&url.stream), Value::string("live")], me.stream_id))?;
        me.wait_publish_start()?;
        Ok(me)
    }

    pub fn stream_id(&self) -> u32 {
        self.stream_id
    }

    /// Bytes handed to the network so far.
    pub fn bytes_sent(&self) -> u64 {
        self.sent
    }

    fn send(&mut self, csid: u32, msg: &Message) -> Result<()> {
        self.scratch.clear();
        self.writer.write(csid, msg, &mut self.scratch);
        self.io.write_all(&self.scratch)?;
        self.sent += self.scratch.len() as u64;
        Ok(())
    }

    /// The `@setDataFrame onMetaData` message (see `flv::metadata_payload`).
    pub fn send_metadata(&mut self, payload: &[u8]) -> Result<()> {
        let msg = Message { timestamp: 0, type_id: MSG_DATA_AMF0, stream_id: self.stream_id, payload: payload.to_vec() };
        self.send(CSID_DATA, &msg)
    }

    pub fn send_video(&mut self, timestamp_ms: u32, flv_body: &[u8]) -> Result<()> {
        let msg = Message { timestamp: timestamp_ms, type_id: MSG_VIDEO, stream_id: self.stream_id, payload: flv_body.to_vec() };
        self.send(CSID_VIDEO, &msg)
    }

    pub fn send_audio(&mut self, timestamp_ms: u32, flv_body: &[u8]) -> Result<()> {
        let msg = Message { timestamp: timestamp_ms, type_id: MSG_AUDIO, stream_id: self.stream_id, payload: flv_body.to_vec() };
        self.send(CSID_AUDIO, &msg)
    }

    /// Reads whatever the server has sent, waiting at most `wait`. Fails if the server hung up or
    /// reported an error; otherwise returns the statuses it sent (usually none).
    pub fn poll(&mut self, wait: Duration) -> Result<Vec<Status>> {
        self.io.set_read_timeout(Some(wait.max(Duration::from_millis(1))))?;
        let n = match self.io.read(&mut self.read_buf) {
            Ok(0) => bail!("The server closed the connection."),
            Ok(n) => n,
            Err(e) if is_timeout(e.kind()) => return Ok(Vec::new()),
            Err(e) => return Err(connection_error(e)),
        };
        let data = self.read_buf[..n].to_vec();
        let messages = self.reader.push(&data)?;
        let mut statuses = Vec::new();
        for msg in &messages {
            if let Some(status) = self.handle(msg)? {
                statuses.push(status);
            }
        }
        self.acknowledge()?;
        for status in &statuses {
            if status.level == "error" {
                return Err(refusal(status));
            }
        }
        Ok(statuses)
    }

    /// Answers what needs answering (pings, window size) and returns a status if the message was one.
    fn handle(&mut self, msg: &Message) -> Result<Option<Status>> {
        match msg.type_id {
            MSG_WINDOW_ACK_SIZE if msg.payload.len() >= 4 => {
                self.window = u32::from_be_bytes([msg.payload[0], msg.payload[1], msg.payload[2], msg.payload[3]]).max(1);
            }
            MSG_SET_PEER_BANDWIDTH => {
                let size = self.window;
                self.send(CSID_CONTROL, &window_ack_size_message(size))?;
            }
            MSG_USER_CONTROL if msg.payload.len() >= 6 && msg.payload[0] == 0 && msg.payload[1] == 6 => {
                // A ping: the answer is the same time back.
                self.send(CSID_CONTROL, &user_control_message(7, &msg.payload[2..6]))?;
            }
            MSG_COMMAND_AMF0 => {
                let values = amf0::decode(&msg.payload).unwrap_or_default();
                let name = values.first().and_then(Value::as_str).unwrap_or("");
                if name == "onStatus" || name == "_error" {
                    let info = values.iter().skip(2).find(|v| matches!(v, Value::Object(_)));
                    let text = |key: &str| info.and_then(|i| i.get(key)).and_then(Value::as_str).unwrap_or("").to_string();
                    let mut status = Status { level: text("level"), code: text("code"), description: text("description") };
                    if name == "_error" && status.level.is_empty() {
                        status.level = "error".into();
                        if status.code.is_empty() {
                            status.code = "NetConnection.Call.Failed".into();
                        }
                    }
                    return Ok(Some(status));
                }
            }
            _ => {}
        }
        Ok(None)
    }

    fn acknowledge(&mut self) -> Result<()> {
        if self.reader.bytes_received - self.acked >= u64::from(self.window) / 2 {
            self.acked = self.reader.bytes_received;
            let total = self.acked as u32;
            self.send(CSID_CONTROL, &ack_message(total))?;
        }
        Ok(())
    }

    /// Reads messages (answering control ones) until `deadline_passes` or `done` accepts one.
    fn wait_for<T>(&mut self, what: &str, mut done: impl FnMut(&mut Self, &Message) -> Result<Option<T>>) -> Result<T> {
        let deadline = Instant::now() + ANSWER_WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                bail!("The server didn't answer ({what}) in time.");
            }
            self.io.set_read_timeout(Some(left))?;
            let n = match self.io.read(&mut self.read_buf) {
                Ok(0) => bail!("The server closed the connection ({what})."),
                Ok(n) => n,
                Err(e) if is_timeout(e.kind()) => bail!("The server didn't answer ({what}) in time."),
                Err(e) => return Err(connection_error(e)),
            };
            let data = self.read_buf[..n].to_vec();
            let messages = self.reader.push(&data)?;
            let mut found = None;
            // Every message is answered, even those after the one being waited for.
            for msg in &messages {
                if let Some(status) = self.handle(msg)? {
                    if status.level == "error" {
                        return Err(refusal(&status));
                    }
                }
                if found.is_none() {
                    found = done(self, msg)?;
                }
            }
            self.acknowledge()?;
            if let Some(found) = found {
                return Ok(found);
            }
        }
    }

    /// Waits for `_result` to transaction `id`; returns the properties and the arguments it carried.
    fn wait_result(&mut self, id: f64) -> Result<(Vec<Value>, Vec<Value>)> {
        self.wait_for("the answer to a request", |_, msg| {
            if msg.type_id != MSG_COMMAND_AMF0 {
                return Ok(None);
            }
            let values = amf0::decode(&msg.payload).unwrap_or_default();
            let is_ours = values.get(1).and_then(Value::as_number) == Some(id);
            match values.first().and_then(Value::as_str) {
                Some("_result") if is_ours => Ok(Some((values.get(2).cloned().into_iter().collect(), values.into_iter().skip(3).collect()))),
                Some("_error") if is_ours => Err(Error::new("The server refused the request.")),
                _ => Ok(None),
            }
        })
    }

    fn wait_publish_start(&mut self) -> Result<()> {
        self.wait_for("publishing", |_, msg| {
            if msg.type_id != MSG_COMMAND_AMF0 {
                return Ok(None);
            }
            let values = amf0::decode(&msg.payload).unwrap_or_default();
            if values.first().and_then(Value::as_str) != Some("onStatus") {
                return Ok(None);
            }
            let code = values.iter().find_map(|v| v.get("code")).and_then(Value::as_str).unwrap_or("");
            Ok(if code == "NetStream.Publish.Start" { Some(()) } else { None })
        })
    }

    /// Says goodbye the polite way (so the channel doesn't stay "live" for a while) and closes.
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let id = self.stream_id;
        let _ = self.send(CSID_COMMAND, &command("closeStream", 0.0, &[Value::Null], id));
        let _ = self.send(CSID_COMMAND, &command("deleteStream", 5.0, &[Value::Null, Value::Number(f64::from(id))], 0));
        let _ = self.io.flush();
    }
}

fn connection_error(e: std::io::Error) -> Error {
    match e.kind() {
        ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted | ErrorKind::BrokenPipe => Error::new("The connection to the server was lost."),
        _ => Error::from(e),
    }
}

impl Duplex for std::net::TcpStream {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> std::io::Result<()> {
        std::net::TcpStream::set_read_timeout(self, timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    fn msg(timestamp: u32, type_id: u8, stream_id: u32, payload: Vec<u8>) -> Message {
        Message { timestamp, type_id, stream_id, payload }
    }

    // ---- addresses ----

    #[test]
    fn reads_twitch_addresses() {
        let u = RtmpUrl::parse("rtmps://live.twitch.tv:443/app/live_123_abc?bandwidthtest=true").unwrap();
        assert_eq!(u, RtmpUrl { tls: true, host: "live.twitch.tv".into(), port: 443, app: "app".into(), stream: "live_123_abc?bandwidthtest=true".into() });
        assert_eq!(u.tc_url(), "rtmps://live.twitch.tv:443/app");
    }

    #[test]
    fn fills_in_ports_and_keeps_slashes_in_the_key() {
        assert_eq!(RtmpUrl::parse("rtmps://x.tv/app/k").unwrap().port, 443);
        assert_eq!(RtmpUrl::parse("rtmp://x.tv/app/k").unwrap().port, 1935);
        let u = RtmpUrl::parse("rtmp://127.0.0.1:19350/app/test/key").unwrap();
        assert_eq!((u.port, u.app.as_str(), u.stream.as_str()), (19350, "app", "test/key"));
    }

    #[test]
    fn refuses_addresses_that_are_not_rtmp_or_lack_a_key() {
        for bad in ["http://x/app/k", "rtmp://", "rtmp://host", "rtmp://host/app", "rtmp://host/app/", "rtmp:///app/k", "rtmp://host:abc/app/k", ""] {
            assert!(RtmpUrl::parse(bad).is_err(), "{bad}");
        }
    }

    // ---- the handshake ----

    #[test]
    fn the_hello_is_c0_then_c1() {
        let hello = client_hello(0x0102_0304, 7);
        assert_eq!(hello.len(), 1537);
        assert_eq!(hello[0], 3);
        assert_eq!(&hello[1..5], &[1, 2, 3, 4]);
        assert_eq!(&hello[5..9], &[0, 0, 0, 0]);
        assert!(hello[9..].iter().any(|b| *b != 0));
        assert_ne!(hello, client_hello(0x0102_0304, 8));
    }

    #[test]
    fn the_reply_echoes_s1_with_our_read_time() {
        let s1: Vec<u8> = (0..HANDSHAKE_SIZE).map(|i| (i % 251) as u8).collect();
        let c2 = client_reply(&s1, 0x0A0B_0C0D).unwrap();
        assert_eq!(&c2[..4], &s1[..4]);
        assert_eq!(&c2[4..8], &[0x0A, 0x0B, 0x0C, 0x0D]);
        assert_eq!(&c2[8..], &s1[8..]);
        assert!(client_reply(&s1[..100], 0).is_err());
    }

    // ---- chunks out ----

    #[test]
    fn the_first_message_is_written_in_full() {
        let mut w = ChunkWriter::default();
        let mut out = Vec::new();
        w.write(3, &msg(1000, 20, 0, vec![1, 2, 3]), &mut out);
        assert_eq!(out, [0x03, 0, 0x03, 0xE8, 0, 0, 3, 20, 0, 0, 0, 0, 1, 2, 3]);
    }

    #[test]
    fn a_long_message_continues_in_format_3_chunks() {
        let mut w = ChunkWriter::default();
        w.set_chunk_size(4);
        let mut out = Vec::new();
        w.write(6, &msg(0, 9, 1, (1..=10).collect()), &mut out);
        assert_eq!(&out[..12], &[0x06, 0, 0, 0, 0, 0, 10, 9, 1, 0, 0, 0]);
        assert_eq!(&out[12..16], &[1, 2, 3, 4]);
        assert_eq!(&out[16..21], &[0xC6, 5, 6, 7, 8]);
        assert_eq!(&out[21..], &[0xC6, 9, 10]);
    }

    #[test]
    fn later_messages_send_only_the_time_that_passed() {
        let mut w = ChunkWriter::default();
        let mut out = Vec::new();
        w.write(6, &msg(100, 9, 1, vec![0xAA; 5]), &mut out);
        out.clear();
        // Same length and type: format 2, just the delta.
        w.write(6, &msg(133, 9, 1, vec![0xBB; 5]), &mut out);
        assert_eq!(out, [0x86, 0, 0, 33, 0xBB, 0xBB, 0xBB, 0xBB, 0xBB]);
        out.clear();
        // A different length: format 1, delta, length and type.
        w.write(6, &msg(150, 9, 1, vec![0xCC; 7]), &mut out);
        assert_eq!(&out[..8], &[0x46, 0, 0, 17, 0, 0, 7, 9]);
        assert_eq!(out.len(), 8 + 7);
    }

    #[test]
    fn time_going_backwards_or_another_message_stream_starts_again_in_full() {
        let mut w = ChunkWriter::default();
        let mut out = Vec::new();
        w.write(6, &msg(500, 9, 1, vec![1]), &mut out);
        out.clear();
        w.write(6, &msg(400, 9, 1, vec![1]), &mut out);
        assert_eq!(out[0] >> 6, 0);
        out.clear();
        w.write(6, &msg(401, 9, 2, vec![1]), &mut out);
        assert_eq!(out[0] >> 6, 0);
    }

    #[test]
    fn each_chunk_stream_keeps_its_own_history() {
        let mut w = ChunkWriter::default();
        let mut out = Vec::new();
        w.write(5, &msg(0, 8, 1, vec![1]), &mut out);
        w.write(6, &msg(0, 9, 1, vec![1]), &mut out);
        out.clear();
        w.write(5, &msg(23, 8, 1, vec![2]), &mut out);
        assert_eq!(out, [0x85, 0, 0, 23, 2]);
    }

    #[test]
    fn big_times_use_the_extended_field_on_every_chunk() {
        let mut w = ChunkWriter::default();
        w.set_chunk_size(2);
        let mut out = Vec::new();
        w.write(6, &msg(0x0200_0000, 9, 1, vec![1, 2, 3]), &mut out);
        assert_eq!(&out[..4], &[0x06, 0xFF, 0xFF, 0xFF]);
        assert_eq!(&out[12..16], &[0x02, 0, 0, 0]);
        assert_eq!(&out[16..18], &[1, 2]);
        assert_eq!(&out[18..24], &[0xC6, 0x02, 0, 0, 0, 3]);
    }

    #[test]
    fn two_byte_chunk_stream_ids() {
        let mut out = Vec::new();
        basic_header(&mut out, 0, 70);
        basic_header(&mut out, 3, 400);
        assert_eq!(out, [0x00, 6, 0xC1, 0x50, 0x01]);
    }

    // ---- chunks in ----

    fn roundtrip(chunk: usize, messages: &[(u32, Message)], split: usize) -> Vec<Message> {
        let mut w = ChunkWriter::default();
        w.set_chunk_size(chunk);
        let mut bytes = Vec::new();
        for (csid, m) in messages {
            w.write(*csid, m, &mut bytes);
        }
        let mut r = ChunkReader { chunk_size: chunk, ..Default::default() };
        let mut got = Vec::new();
        for piece in bytes.chunks(split) {
            got.extend(r.push(piece).unwrap());
        }
        got
    }

    #[test]
    fn reads_back_what_the_writer_wrote_however_the_bytes_arrive() {
        let messages = vec![
            (5, msg(0, 8, 1, vec![0xAF, 0, 0x11, 0x90])),
            (6, msg(0, 9, 1, (0..3000).map(|i| (i % 256) as u8).collect())),
            (6, msg(16, 9, 1, vec![9; 3000])),
            (5, msg(23, 8, 1, vec![0xAF, 1, 7, 7, 7])),
            (6, msg(33, 9, 1, vec![1; 10])),
            (6, msg(0x0200_0010, 9, 1, vec![2; 700])),
            (3, msg(0, 20, 0, vec![5; 0])),
        ];
        for chunk in [128, 4096, 5] {
            for split in [1, 3, 64, 100_000] {
                assert_eq!(roundtrip(chunk, &messages, split), messages.iter().map(|(_, m)| m.clone()).collect::<Vec<_>>(), "chunk {chunk} split {split}");
            }
        }
    }

    #[test]
    fn follows_a_set_chunk_size_from_the_server() {
        let mut r = ChunkReader::default();
        let mut w = ChunkWriter::default();
        let mut bytes = Vec::new();
        w.write(2, &set_chunk_size_message(1000), &mut bytes);
        w.set_chunk_size(1000);
        w.write(4, &msg(0, 20, 1, vec![7; 900]), &mut bytes);
        let got = r.push(&bytes).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].payload.len(), 900);
        assert_eq!(r.bytes_received, bytes.len() as u64);
    }

    #[test]
    fn interleaved_chunk_streams_do_not_mix() {
        // Two long messages whose chunks alternate on the wire.
        let a: Vec<u8> = vec![1; 300];
        let b: Vec<u8> = vec![2; 300];
        let mut bytes = Vec::new();
        for (csid, fill, ts) in [(5u8, 1u8, 0u32), (6u8, 2u8, 0u32)] {
            bytes.push(csid);
            bytes.extend_from_slice(&ts.to_be_bytes()[1..]);
            bytes.extend_from_slice(&[0, 1, 44, if csid == 5 { 8 } else { 9 }, 1, 0, 0, 0]);
            bytes.extend(std::iter::repeat_n(fill, 128));
        }
        for csid in [5u8, 6u8] {
            let fill = if csid == 5 { 1 } else { 2 };
            bytes.push(0xC0 | csid);
            bytes.extend(std::iter::repeat_n(fill, 128));
        }
        for csid in [5u8, 6u8] {
            let fill = if csid == 5 { 1 } else { 2 };
            bytes.push(0xC0 | csid);
            bytes.extend(std::iter::repeat_n(fill, 44));
        }
        let got = ChunkReader::default().push(&bytes).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].type_id, &got[0].payload), (8, &a));
        assert_eq!((got[1].type_id, &got[1].payload), (9, &b));
    }

    // ---- the conversation, against a small stand-in for a server ----

    /// Accepts one client, plays the server's part and keeps what the client published.
    fn fake_server(refuse_publish: bool) -> (u16, std::thread::JoinHandle<Vec<Message>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut c0c1 = vec![0u8; 1 + HANDSHAKE_SIZE];
            sock.read_exact(&mut c0c1).unwrap();
            let mut s = vec![3u8];
            s.extend_from_slice(&c0c1[1..]); // S1
            s.extend_from_slice(&c0c1[1..]); // S2
            sock.write_all(&s).unwrap();
            let mut c2 = vec![0u8; HANDSHAKE_SIZE];
            sock.read_exact(&mut c2).unwrap();

            let mut reader = ChunkReader::default();
            let mut writer = ChunkWriter::default();
            let mut seen = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = match sock.read(&mut buf) {
                    Ok(0) | Err(_) => return seen,
                    Ok(n) => n,
                };
                for m in reader.push(&buf[..n]).unwrap() {
                    let mut out = Vec::new();
                    if m.type_id == MSG_COMMAND_AMF0 {
                        let v = amf0::decode(&m.payload).unwrap();
                        match v[0].as_str().unwrap() {
                            "connect" => {
                                writer.write(2, &window_ack_size_message(2_500_000), &mut out);
                                writer.write(
                                    2,
                                    &Message { timestamp: 0, type_id: MSG_SET_PEER_BANDWIDTH, stream_id: 0, payload: vec![0, 0x26, 0x25, 0xA0, 2] },
                                    &mut out,
                                );
                                writer.write(2, &user_control_message(0, &[0, 0, 0, 0]), &mut out);
                                writer.write(
                                    3,
                                    &command(
                                        "_result",
                                        1.0,
                                        &[
                                            Value::object(&[("fmsVer", Value::string("FMS/3"))]),
                                            Value::object(&[("code", Value::string("NetConnection.Connect.Success"))]),
                                        ],
                                        0,
                                    ),
                                    &mut out,
                                );
                            }
                            "createStream" => writer.write(3, &command("_result", 4.0, &[Value::Null, Value::Number(1.0)], 0), &mut out),
                            "publish" => {
                                let code = if refuse_publish { "NetStream.Publish.BadName" } else { "NetStream.Publish.Start" };
                                let level = if refuse_publish { "error" } else { "status" };
                                writer.write(
                                    3,
                                    &command(
                                        "onStatus",
                                        0.0,
                                        &[
                                            Value::Null,
                                            Value::object(&[
                                                ("level", Value::string(level)),
                                                ("code", Value::string(code)),
                                                ("description", Value::string("x")),
                                            ]),
                                        ],
                                        1,
                                    ),
                                    &mut out,
                                );
                            }
                            _ => {}
                        }
                    }
                    seen.push(m);
                    if !out.is_empty() {
                        sock.write_all(&out).unwrap();
                    }
                }
            }
        });
        (port, handle)
    }

    #[test]
    fn publishes_to_a_server_and_it_receives_everything() {
        let (port, server) = fake_server(false);
        let url = RtmpUrl::parse(&format!("rtmp://127.0.0.1:{port}/app/testkey")).unwrap();
        let sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut p = Publisher::open(sock, &url, 1234, 5).unwrap();
        assert_eq!(p.stream_id(), 1);
        p.send_metadata(&[2, 0, 1, b'x']).unwrap();
        p.send_video(0, &[0x17, 0, 0, 0, 0, 1]).unwrap();
        p.send_video(33, &vec![0x27; 10_000]).unwrap(); // longer than a chunk
        p.send_audio(40, &[0xAF, 1, 9]).unwrap();
        assert!(p.poll(Duration::from_millis(5)).unwrap().is_empty());
        p.close();
        drop(p);
        let seen = server.join().unwrap();

        let by_type = |t: u8| seen.iter().filter(move |m| m.type_id == t).collect::<Vec<_>>();
        let commands: Vec<String> = by_type(MSG_COMMAND_AMF0).iter().map(|m| amf0::decode(&m.payload).unwrap()[0].as_str().unwrap().to_string()).collect();
        assert_eq!(commands, ["connect", "releaseStream", "FCPublish", "createStream", "publish", "closeStream", "deleteStream"]);
        assert_eq!(by_type(MSG_SET_CHUNK_SIZE)[0].payload, 4096u32.to_be_bytes());

        let connect = amf0::decode(&by_type(MSG_COMMAND_AMF0)[0].payload).unwrap();
        assert_eq!(connect[2].get("app").and_then(Value::as_str), Some("app"));
        assert_eq!(connect[2].get("tcUrl").and_then(Value::as_str), Some(format!("rtmp://127.0.0.1:{port}/app").as_str()));
        let publish = amf0::decode(&by_type(MSG_COMMAND_AMF0)[4].payload).unwrap();
        assert_eq!(publish[3].as_str(), Some("testkey"));
        assert_eq!(publish[4].as_str(), Some("live"));

        let video = by_type(MSG_VIDEO);
        assert_eq!((video.len(), video[0].timestamp, video[1].timestamp, video[1].payload.len(), video[1].stream_id), (2, 0, 33, 10_000, 1));
        assert_eq!(by_type(MSG_AUDIO)[0].payload, [0xAF, 1, 9]);
        assert_eq!(by_type(MSG_DATA_AMF0)[0].payload, [2, 0, 1, b'x']);
    }

    #[test]
    fn says_so_when_the_server_turns_the_stream_away() {
        let (port, server) = fake_server(true);
        let url = RtmpUrl::parse(&format!("rtmp://127.0.0.1:{port}/app/badkey")).unwrap();
        let err = Publisher::open(TcpStream::connect(("127.0.0.1", port)).unwrap(), &url, 0, 1).err().expect("should fail");
        assert!(err.message().contains("stream key"), "{err}");
        let _ = server.join();
    }

    #[test]
    fn says_so_when_the_server_hangs_up() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || drop(listener.accept()));
        let url = RtmpUrl::parse(&format!("rtmp://127.0.0.1:{port}/app/k")).unwrap();
        let err = Publisher::open(TcpStream::connect(("127.0.0.1", port)).unwrap(), &url, 0, 1).err().expect("should fail");
        assert!(err.message().contains("hung up") || err.message().contains("closed") || err.message().contains("lost"), "{err}");
    }

    #[test]
    fn acknowledges_what_it_has_received_and_answers_pings() {
        // Drive `handle`/`acknowledge` through a server that sends a ping and a lot of data.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut c0c1 = vec![0u8; 1 + HANDSHAKE_SIZE];
            sock.read_exact(&mut c0c1).unwrap();
            let mut s = vec![3u8];
            s.extend_from_slice(&c0c1[1..]);
            s.extend_from_slice(&c0c1[1..]);
            sock.write_all(&s).unwrap();
            let mut c2 = vec![0u8; HANDSHAKE_SIZE];
            sock.read_exact(&mut c2).unwrap();
            let mut reader = ChunkReader::default();
            let mut writer = ChunkWriter::default();
            let mut buf = [0u8; 4096];
            let mut replies = Vec::new();
            let mut announced = false;
            loop {
                let n = match sock.read(&mut buf) {
                    Ok(0) | Err(_) => return replies,
                    Ok(n) => n,
                };
                for m in reader.push(&buf[..n]).unwrap() {
                    let mut out = Vec::new();
                    if m.type_id == MSG_COMMAND_AMF0 {
                        let v = amf0::decode(&m.payload).unwrap();
                        match v[0].as_str().unwrap() {
                            "connect" => {
                                // A tiny window, so the next bytes force an acknowledgement.
                                writer.write(2, &window_ack_size_message(100), &mut out);
                                writer.write(3, &command("_result", 1.0, &[Value::Null, Value::Null], 0), &mut out);
                            }
                            "createStream" => writer.write(3, &command("_result", 4.0, &[Value::Null, Value::Number(1.0)], 0), &mut out),
                            "publish" => {
                                writer.write(
                                    3,
                                    &command("onStatus", 0.0, &[Value::Null, Value::object(&[("code", Value::string("NetStream.Publish.Start"))])], 1),
                                    &mut out,
                                );
                                writer.write(2, &user_control_message(6, &[0, 0, 0x12, 0x34]), &mut out);
                                announced = true;
                            }
                            _ => {}
                        }
                    }
                    replies.push(m);
                    if !out.is_empty() {
                        sock.write_all(&out).unwrap();
                    }
                }
                let _ = announced;
            }
        });
        let url = RtmpUrl::parse(&format!("rtmp://127.0.0.1:{port}/app/k")).unwrap();
        let mut p = Publisher::open(TcpStream::connect(("127.0.0.1", port)).unwrap(), &url, 0, 1).unwrap();
        for _ in 0..4 {
            let _ = p.poll(Duration::from_millis(20)).unwrap();
        }
        p.close();
        drop(p);
        let got = server.join().unwrap();
        assert!(got.iter().any(|m| m.type_id == MSG_ACK), "an acknowledgement should have gone out");
        let pong = got.iter().find(|m| m.type_id == MSG_USER_CONTROL).expect("a ping answer");
        assert_eq!(pong.payload, [0, 7, 0, 0, 0x12, 0x34]);
    }
}
