//! Where the finished stream goes: an RTMP server, or (for testing and tooling) an FLV file.
//!
//! The network thread only knows this interface, so a stream to a file takes exactly the same road
//! as a stream to Twitch: the same packets, the same time stamps, the same order.

use crate::error::{Context, Result};
use crate::flv;
use crate::rtmp::{Duplex, Publisher};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Duration;

pub trait Sink {
    /// The `@setDataFrame onMetaData` message (see `flv::metadata_payload`).
    fn send_metadata(&mut self, payload: &[u8]) -> Result<()>;
    fn send_video(&mut self, timestamp_ms: u32, flv_body: &[u8]) -> Result<()>;
    fn send_audio(&mut self, timestamp_ms: u32, flv_body: &[u8]) -> Result<()>;
    /// Called every so often: a server is listened to (it can hang up or refuse), a file has nothing to say.
    fn poll(&mut self, wait: Duration) -> Result<()>;
    /// Bytes handed on so far.
    fn bytes_sent(&self) -> u64;
    /// Finishes politely.
    fn close(&mut self);
}

impl<S: Duplex> Sink for Publisher<S> {
    fn send_metadata(&mut self, payload: &[u8]) -> Result<()> {
        Publisher::send_metadata(self, payload)
    }

    fn send_video(&mut self, timestamp_ms: u32, flv_body: &[u8]) -> Result<()> {
        Publisher::send_video(self, timestamp_ms, flv_body)
    }

    fn send_audio(&mut self, timestamp_ms: u32, flv_body: &[u8]) -> Result<()> {
        Publisher::send_audio(self, timestamp_ms, flv_body)
    }

    fn poll(&mut self, wait: Duration) -> Result<()> {
        Publisher::poll(self, wait).map(|_| ())
    }

    fn bytes_sent(&self) -> u64 {
        Publisher::bytes_sent(self)
    }

    fn close(&mut self) {
        Publisher::close(self)
    }
}

/// An FLV file written one tag at a time.
pub struct FileSink<W: Write> {
    out: flv::FlvWriter<W>,
    written: u64,
}

impl FileSink<BufWriter<File>> {
    /// Creates (or replaces) the file at `path`.
    pub fn create(path: &Path, has_audio: bool) -> Result<Self> {
        let file = File::create(path).context("Couldn't create the file to write the stream to")?;
        FileSink::new(BufWriter::with_capacity(1 << 20, file), has_audio)
    }
}

/// The AMF0 string `@setDataFrame` that RTMP puts in front of the metadata and a file doesn't have.
const SET_DATA_FRAME: &[u8] = b"\x02\x00\x0d@setDataFrame";

impl<W: Write> FileSink<W> {
    pub fn new(out: W, has_audio: bool) -> Result<Self> {
        let out = flv::FlvWriter::new(out, true, has_audio).context("Couldn't write to the stream file")?;
        Ok(FileSink { out, written: 13 })
    }

    fn tag(&mut self, kind: u8, timestamp_ms: u32, body: &[u8]) -> Result<()> {
        self.out.tag(kind, timestamp_ms, body).context("Couldn't write to the stream file")?;
        self.written += 15 + body.len() as u64;
        Ok(())
    }

    pub fn into_inner(self) -> W {
        self.out.into_inner()
    }
}

impl<W: Write> Sink for FileSink<W> {
    fn send_metadata(&mut self, payload: &[u8]) -> Result<()> {
        // In a file the script tag starts at "onMetaData".
        let body = payload.strip_prefix(SET_DATA_FRAME).unwrap_or(payload);
        self.tag(flv::TAG_SCRIPT, 0, body)
    }

    fn send_video(&mut self, timestamp_ms: u32, flv_body: &[u8]) -> Result<()> {
        self.tag(flv::TAG_VIDEO, timestamp_ms, flv_body)
    }

    fn send_audio(&mut self, timestamp_ms: u32, flv_body: &[u8]) -> Result<()> {
        self.tag(flv::TAG_AUDIO, timestamp_ms, flv_body)
    }

    fn poll(&mut self, _wait: Duration) -> Result<()> {
        Ok(())
    }

    fn bytes_sent(&self) -> u64 {
        self.written
    }

    fn close(&mut self) {
        let _ = self.out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::amf0;

    fn payload() -> Vec<u8> {
        flv::metadata_payload(&flv::Metadata { width: 1920, height: 1080, fps: 60, video_kbps: 6000, audio_kbps: 160, encoder: "Uncbox".into() })
    }

    #[test]
    fn a_file_has_the_header_then_the_tags_in_the_order_sent() {
        let mut sink = FileSink::new(Vec::new(), true).unwrap();
        sink.send_metadata(&payload()).unwrap();
        sink.send_video(0, &[0x17, 0, 0, 0, 0, 1]).unwrap();
        sink.send_audio(5, &[0xAF, 0, 0x11, 0x90]).unwrap();
        sink.send_video(33, &[0x27, 1, 0, 0, 33, 9]).unwrap();
        let written = sink.bytes_sent();
        let bytes = sink.into_inner();
        assert_eq!(written, bytes.len() as u64, "the count is what the file holds");
        assert_eq!(&bytes[..13], &flv::file_header(true, true));
        // Walk the tags.
        let mut at = 13;
        let mut seen = Vec::new();
        while at < bytes.len() {
            let kind = bytes[at];
            let size = u32::from_be_bytes([0, bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
            let ts = u32::from_be_bytes([bytes[at + 7], bytes[at + 4], bytes[at + 5], bytes[at + 6]]);
            seen.push((kind, ts));
            at += 11 + size + 4;
        }
        assert_eq!(at, bytes.len());
        assert_eq!(seen, vec![(flv::TAG_SCRIPT, 0), (flv::TAG_VIDEO, 0), (flv::TAG_AUDIO, 5), (flv::TAG_VIDEO, 33)]);
    }

    #[test]
    fn the_script_tag_in_a_file_starts_at_on_meta_data() {
        let mut sink = FileSink::new(Vec::new(), false).unwrap();
        sink.send_metadata(&payload()).unwrap();
        let bytes = sink.into_inner();
        // The tag body starts after the 13-byte file header and the 11-byte tag header.
        let values = amf0::decode(&bytes[13 + 11..bytes.len() - 4]).unwrap();
        assert_eq!(values[0].as_str(), Some("onMetaData"));
        assert_eq!(values[1].get("width").and_then(amf0::Value::as_number), Some(1920.0));
        assert_eq!(bytes[4], 1, "video only");
    }

    #[test]
    fn metadata_without_the_rtmp_prefix_is_written_as_it_is() {
        let mut sink = FileSink::new(Vec::new(), true).unwrap();
        let bare = amf0::encode(&[amf0::Value::string("onMetaData"), amf0::Value::EcmaArray(vec![])]);
        sink.send_metadata(&bare).unwrap();
        let bytes = sink.into_inner();
        assert_eq!(&bytes[13 + 11..bytes.len() - 4], bare.as_slice());
    }

    #[test]
    fn polling_a_file_and_closing_it_are_harmless() {
        let mut sink = FileSink::new(Vec::new(), true).unwrap();
        sink.poll(Duration::from_millis(1)).unwrap();
        sink.close();
        sink.close();
    }

    #[test]
    fn a_file_can_really_be_created() {
        let dir = std::env::temp_dir().join(format!("uncbox-sink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.flv");
        {
            let mut sink = FileSink::create(&path, true).unwrap();
            sink.send_video(0, &[0x17, 1, 0, 0, 0, 1, 2]).unwrap();
            sink.close();
        }
        let size = std::fs::metadata(&path).unwrap().len();
        assert_eq!(size, 13 + 15 + 7);
        std::fs::remove_dir_all(&dir).unwrap();
        // A folder that isn't there is a plain sentence, not a panic.
        assert!(FileSink::create(&dir.join("nope").join("x.flv"), true).is_err());
    }
}
