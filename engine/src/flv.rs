//! FLV: the container Twitch's ingest (and every RTMP server) takes. RTMP carries FLV tags without
//! the tag header (the message type and time stamp are in the RTMP message instead), so the first
//! half of this file builds tag *bodies*. [`FlvWriter`] adds the file framing, for tests and for a
//! future "record to file".

use crate::amf0::{self, Value};

pub const TAG_AUDIO: u8 = 8;
pub const TAG_VIDEO: u8 = 9;
pub const TAG_SCRIPT: u8 = 18;

/// What an AVC video tag carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvcPacket {
    /// The decoder configuration, once, before any picture.
    SequenceHeader = 0,
    /// One picture as length-prefixed NAL units.
    Nalu = 1,
    EndOfSequence = 2,
}

/// The body of a video tag. `cts_ms` is how long after its decode time the picture is shown (it is
/// 0 unless the encoder reorders pictures with B-frames).
pub fn video_body(keyframe: bool, packet: AvcPacket, cts_ms: i32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + data.len());
    out.push(if keyframe { 0x17 } else { 0x27 }); // frame type (1 key, 2 inter) and codec 7 (AVC)
    out.push(packet as u8);
    let cts = cts_ms.clamp(-0x80_0000, 0x7F_FFFF);
    out.extend_from_slice(&cts.to_be_bytes()[1..4]);
    out.extend_from_slice(data);
    out
}

/// What an AAC audio tag carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AacPacket {
    /// The two-byte AudioSpecificConfig, once, before any sound.
    SequenceHeader = 0,
    Raw = 1,
}

/// The body of an audio tag for AAC at 48 kHz stereo, as FLV always labels AAC (`0xAF`).
pub fn audio_body(packet: AacPacket, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + data.len());
    out.push(0xAF);
    out.push(packet as u8);
    out.extend_from_slice(data);
    out
}

/// The AudioSpecificConfig for AAC-LC: object type 2, the sample rate index, the channel count.
pub fn aac_config(sample_rate: u32, channels: u8) -> [u8; 2] {
    const RATES: [u32; 13] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let index = RATES.iter().position(|&r| r == sample_rate).unwrap_or(3) as u16;
    let bits = (2u16 << 11) | (index << 7) | (u16::from(channels) << 3);
    bits.to_be_bytes()
}

/// What `onMetaData` tells players about the stream.
#[derive(Debug, Clone)]
pub struct Metadata {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
    pub audio_kbps: u32,
    pub encoder: String,
}

/// The payload of the `@setDataFrame` message: the name of the call, `onMetaData`, and the values.
pub fn metadata_payload(meta: &Metadata) -> Vec<u8> {
    let number = |n: u32| Value::Number(f64::from(n));
    amf0::encode(&[
        Value::string("@setDataFrame"),
        Value::string("onMetaData"),
        Value::EcmaArray(vec![
            ("duration".into(), number(0)),
            ("width".into(), number(meta.width)),
            ("height".into(), number(meta.height)),
            ("videodatarate".into(), number(meta.video_kbps)),
            ("framerate".into(), number(meta.fps)),
            ("videocodecid".into(), number(7)),
            ("audiodatarate".into(), number(meta.audio_kbps)),
            ("audiosamplerate".into(), number(48000)),
            ("audiosamplesize".into(), number(16)),
            ("stereo".into(), Value::Boolean(true)),
            ("audiocodecid".into(), number(10)),
            ("encoder".into(), Value::String(meta.encoder.clone())),
            ("filesize".into(), number(0)),
        ]),
    ])
}

/// The first nine bytes of an FLV file and the zero "previous tag size" after them.
pub fn file_header(has_video: bool, has_audio: bool) -> [u8; 13] {
    let flags = u8::from(has_audio) << 2 | u8::from(has_video);
    [b'F', b'L', b'V', 1, flags, 0, 0, 0, 9, 0, 0, 0, 0]
}

/// One tag as it sits in an FLV file: an 11-byte header, the body, and the tag's total size.
pub fn file_tag(tag_type: u8, timestamp_ms: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(15 + body.len());
    out.push(tag_type);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..4]);
    out.extend_from_slice(&timestamp_ms.to_be_bytes()[1..4]); // low 24 bits
    out.push((timestamp_ms >> 24) as u8); // then the top 8
    out.extend_from_slice(&[0, 0, 0]); // stream id, always 0 in a file
    out.extend_from_slice(body);
    out.extend_from_slice(&((11 + body.len()) as u32).to_be_bytes());
    out
}

/// Writes an FLV file one tag at a time.
pub struct FlvWriter<W: std::io::Write> {
    out: W,
}

impl<W: std::io::Write> FlvWriter<W> {
    pub fn new(mut out: W, has_video: bool, has_audio: bool) -> std::io::Result<Self> {
        out.write_all(&file_header(has_video, has_audio))?;
        Ok(FlvWriter { out })
    }

    pub fn tag(&mut self, tag_type: u8, timestamp_ms: u32, body: &[u8]) -> std::io::Result<()> {
        self.out.write_all(&file_tag(tag_type, timestamp_ms, body))
    }

    pub fn into_inner(self) -> W {
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_tags_say_key_or_inter_and_carry_the_composition_time() {
        let key = video_body(true, AvcPacket::Nalu, 0, &[9, 9]);
        assert_eq!(key, [0x17, 1, 0, 0, 0, 9, 9]);
        let inter = video_body(false, AvcPacket::Nalu, 33, &[1]);
        assert_eq!(inter, [0x27, 1, 0, 0, 33, 1]);
        let header = video_body(true, AvcPacket::SequenceHeader, 0, &[1, 2, 3]);
        assert_eq!(&header[..5], &[0x17, 0, 0, 0, 0]);
        let end = video_body(false, AvcPacket::EndOfSequence, 0, &[]);
        assert_eq!(end, [0x27, 2, 0, 0, 0]);
    }

    #[test]
    fn composition_time_can_be_negative_and_is_held_to_24_bits() {
        assert_eq!(&video_body(false, AvcPacket::Nalu, -1, &[])[2..5], &[0xFF, 0xFF, 0xFF]);
        assert_eq!(&video_body(false, AvcPacket::Nalu, 1_000_000_000, &[])[2..5], &[0x7F, 0xFF, 0xFF]);
        assert_eq!(&video_body(false, AvcPacket::Nalu, 0x0102, &[])[2..5], &[0, 1, 2]);
    }

    #[test]
    fn audio_tags_are_labelled_aac_stereo_48k() {
        assert_eq!(audio_body(AacPacket::SequenceHeader, &[0x11, 0x90]), [0xAF, 0, 0x11, 0x90]);
        assert_eq!(audio_body(AacPacket::Raw, &[7, 8]), [0xAF, 1, 7, 8]);
    }

    #[test]
    fn the_aac_config_is_what_players_expect() {
        assert_eq!(aac_config(48000, 2), [0x11, 0x90]);
        assert_eq!(aac_config(44100, 2), [0x12, 0x10]);
        assert_eq!(aac_config(48000, 1), [0x11, 0x88]);
    }

    #[test]
    fn metadata_reads_back_as_the_values_given() {
        let payload = metadata_payload(&Metadata { width: 1920, height: 1080, fps: 60, video_kbps: 6000, audio_kbps: 160, encoder: "Uncbox".into() });
        let values = amf0::decode(&payload).unwrap();
        assert_eq!(values[0].as_str(), Some("@setDataFrame"));
        assert_eq!(values[1].as_str(), Some("onMetaData"));
        assert_eq!(values[2].get("width").and_then(Value::as_number), Some(1920.0));
        assert_eq!(values[2].get("height").and_then(Value::as_number), Some(1080.0));
        assert_eq!(values[2].get("framerate").and_then(Value::as_number), Some(60.0));
        assert_eq!(values[2].get("videocodecid").and_then(Value::as_number), Some(7.0));
        assert_eq!(values[2].get("audiocodecid").and_then(Value::as_number), Some(10.0));
        assert_eq!(values[2].get("stereo"), Some(&Value::Boolean(true)));
    }

    #[test]
    fn the_file_header_says_what_it_holds() {
        assert_eq!(file_header(true, true), [b'F', b'L', b'V', 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
        assert_eq!(file_header(true, false)[4], 1);
        assert_eq!(file_header(false, true)[4], 4);
    }

    #[test]
    fn a_file_tag_has_header_body_and_size() {
        let tag = file_tag(TAG_VIDEO, 0x0102_0304, &[0xAA, 0xBB, 0xCC]);
        assert_eq!(tag, [9, 0, 0, 3, 0x02, 0x03, 0x04, 0x01, 0, 0, 0, 0xAA, 0xBB, 0xCC, 0, 0, 0, 14]);
    }

    #[test]
    fn the_writer_puts_it_together() {
        let mut w = FlvWriter::new(Vec::new(), true, true).unwrap();
        w.tag(TAG_AUDIO, 0, &[0xAF, 0, 0x11, 0x90]).unwrap();
        w.tag(TAG_SCRIPT, 5, &[2]).unwrap();
        let bytes = w.into_inner();
        assert_eq!(&bytes[..13], &file_header(true, true));
        assert_eq!(bytes[13], TAG_AUDIO);
        assert_eq!(bytes.len(), 13 + (11 + 4 + 4) + (11 + 1 + 4));
        assert_eq!(bytes[13 + 19], TAG_SCRIPT);
    }
}
