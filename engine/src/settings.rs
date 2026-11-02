//! Everything a stream can be told, in one place.
//!
//! The server (server/stream.mjs) writes one JSON line to our stdin: `{ url, screen, fps, height,
//! kbps, audioPipe?, encoder?, keyframeSeconds?, audioKbps? }`. It is read here and held to what
//! Uncbox offers, the same way `clampSettings` does it on the server, so a bad number from outside
//! never reaches the capture or the encoder. Fields we don't know are ignored, which lets the
//! config grow (another service, a second output, a recording, overlays) without breaking older
//! callers: add a field here, give it a default, and read it where it is needed.

use crate::error::{Error, Result};
use crate::redact;
use serde_json::Value;
use std::fmt;

/// Which hardware encoder to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderChoice {
    /// The one on the graphics card that owns the screen being captured.
    Auto,
    Nvidia,
    Amd,
    Intel,
}

impl EncoderChoice {
    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Some(Self::Auto),
            "nvidia" | "nvenc" => Some(Self::Nvidia),
            "amd" | "amf" => Some(Self::Amd),
            "intel" | "qsv" => Some(Self::Intel),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Nvidia => "nvidia",
            Self::Amd => "amd",
            Self::Intel => "intel",
        }
    }
}

#[derive(Clone)]
pub struct Settings {
    /// Where the stream goes: `rtmp://` or `rtmps://`, with the stream key in the path. This is a
    /// secret: it is never printed (see the `Debug` below) and is registered with [`redact`].
    pub url: String,
    /// Which monitor to capture, counting from 0 across all graphics cards (0 is the main one).
    pub screen: u32,
    /// 30 or 60.
    pub fps: u32,
    /// Picture height to send: 720, 1080, or 0 for the screen's own size.
    pub height: u32,
    /// Video bitrate in kbit/s, 2500 to 8000. The encoder holds it constant.
    pub kbps: u32,
    /// The Uncbox app's named pipe with the sound, or none for silence.
    pub audio_pipe: Option<String>,
    pub encoder: EncoderChoice,
    /// Seconds between keyframes, 1 to 4 (Twitch wants 2 or less).
    pub keyframe_seconds: u32,
    /// AAC bitrate in kbit/s: 96, 128, 160 or 192.
    pub audio_kbps: u32,
    /// B-frames between reference frames, 0 to 3, when the encoder supports them (they cost a little
    /// delay and save a lot of bitrate).
    pub bframes: u32,
    /// How much the encoder trades speed for looks, 0 to 100 (100 is best looking and slowest).
    pub quality: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            url: String::new(),
            screen: 0,
            fps: 60,
            height: 1080,
            kbps: 6000,
            audio_pipe: None,
            encoder: EncoderChoice::Auto,
            keyframe_seconds: 2,
            audio_kbps: 160,
            bframes: 2,
            quality: 80,
        }
    }
}

impl fmt::Debug for Settings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Settings")
            .field("url", &"<hidden>")
            .field("screen", &self.screen)
            .field("fps", &self.fps)
            .field("height", &self.height)
            .field("kbps", &self.kbps)
            .field("audio_pipe", &self.audio_pipe)
            .field("encoder", &self.encoder)
            .field("keyframe_seconds", &self.keyframe_seconds)
            .field("audio_kbps", &self.audio_kbps)
            .field("bframes", &self.bframes)
            .field("quality", &self.quality)
            .finish()
    }
}

/// A number from the config as a whole number, or the fallback for anything else.
fn whole(value: Option<&Value>, fallback: i64) -> i64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => n.round() as i64,
        _ => fallback,
    }
}

/// The only audio source the shell makes: `\\.\pipe\uncbox-stream-audio-<8 to 32 hex digits>`.
pub fn is_audio_pipe_name(name: &str) -> bool {
    const PREFIX: &str = r"\\.\pipe\uncbox-stream-audio-";
    match name.strip_prefix(PREFIX) {
        Some(rest) => (8..=32).contains(&rest.len()) && rest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        None => false,
    }
}

impl Settings {
    /// Reads and clamps the config line. Fails (with a sentence for the person) only when there is
    /// nothing sensible to do: no usable address, or a sound pipe that isn't Uncbox's.
    pub fn from_json(text: &str) -> Result<Settings> {
        let value: Value = serde_json::from_str(text.trim()).map_err(|_| Error::new("The stream settings weren't understood."))?;
        Self::from_value(&value)
    }

    pub fn from_value(value: &Value) -> Result<Settings> {
        let defaults = Settings::default();
        let url = value.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !(url.starts_with("rtmp://") || url.starts_with("rtmps://")) {
            return Err(Error::new("There is no stream address to send to."));
        }
        redact::add_secret(&url);
        if let Some(key) = url.splitn(4, '/').nth(3).and_then(|path| path.split_once('/')).map(|(_, rest)| rest) {
            redact::add_secret(key);
            // The key without a query ("?bandwidthtest=true") is also a secret on its own.
            if let Some((bare, _)) = key.split_once('?') {
                redact::add_secret(bare);
            }
        }

        let audio_pipe = match value.get("audioPipe") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            Some(Value::String(s)) if is_audio_pipe_name(s) => Some(s.clone()),
            Some(_) => return Err(Error::new("That isn't a sound pipe made by the Uncbox app.")),
        };

        let height = whole(value.get("height"), i64::from(defaults.height));
        let audio = whole(value.get("audioKbps"), i64::from(defaults.audio_kbps));
        Ok(Settings {
            url,
            screen: whole(value.get("screen"), i64::from(defaults.screen)).clamp(0, 7) as u32,
            fps: if whole(value.get("fps"), 60) == 30 { 30 } else { 60 },
            height: if matches!(height, 0 | 720 | 1080) { height as u32 } else { defaults.height },
            kbps: whole(value.get("kbps"), i64::from(defaults.kbps)).clamp(2500, 8000) as u32,
            audio_pipe,
            encoder: value.get("encoder").and_then(Value::as_str).and_then(EncoderChoice::parse).unwrap_or(defaults.encoder),
            keyframe_seconds: whole(value.get("keyframeSeconds"), i64::from(defaults.keyframe_seconds)).clamp(1, 4) as u32,
            bframes: whole(value.get("bframes"), i64::from(defaults.bframes)).clamp(0, 3) as u32,
            quality: whole(value.get("quality"), i64::from(defaults.quality)).clamp(0, 100) as u32,
            // The AAC encoder only makes these four for stereo at 48 kHz: pick the nearest.
            audio_kbps: [96, 128, 160, 192].into_iter().min_by_key(|k| (i64::from(*k) - audio).abs()).unwrap_or(160),
        })
    }

    /// Frames between keyframes.
    pub fn gop(&self) -> u32 {
        self.fps * self.keyframe_seconds
    }
}

/// The size to send for a screen of `src_w` x `src_h`: the height asked for (0 keeps the screen's
/// own), the width that keeps the shape, both even because H.264 4:2:0 needs it.
pub fn target_size(src_w: u32, src_h: u32, height: u32) -> (u32, u32) {
    let even = |n: u32| (n.max(2) / 2) * 2;
    if src_w == 0 || src_h == 0 {
        return (even(src_w), even(src_h));
    }
    let h = if height == 0 { even(src_h) } else { even(height) };
    let w = if height == 0 { even(src_w) } else { even(((u64::from(src_w) * u64::from(h) + u64::from(src_h) / 2) / u64::from(src_h)) as u32) };
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "rtmps://live.twitch.tv:443/app/live_123456789_AbCdEfGhIjKlMnOpQrSt";
    const PIPE: &str = r"\\.\pipe\uncbox-stream-audio-1a2b3c4d";

    fn parse(extra: &str) -> Settings {
        Settings::from_json(&format!(r#"{{"url":"{URL}"{extra}}}"#)).unwrap()
    }

    #[test]
    fn keeps_what_uncbox_offers() {
        let s = parse(r#","screen":2,"fps":30,"height":720,"kbps":4500"#);
        assert_eq!((s.screen, s.fps, s.height, s.kbps), (2, 30, 720, 4500));
        assert_eq!(parse(r#","height":0"#).height, 0);
    }

    #[test]
    fn pulls_everything_into_range() {
        let s = parse(r#","screen":99,"fps":144,"height":900,"kbps":99999"#);
        assert_eq!((s.screen, s.fps, s.height, s.kbps), (7, 60, 1080, 8000));
        let s = parse(r#","screen":-3,"kbps":10"#);
        assert_eq!((s.screen, s.kbps), (0, 2500));
        assert_eq!(parse(r#","screen":1.6"#).screen, 2);
    }

    #[test]
    fn falls_back_to_the_defaults_for_nonsense() {
        let s = parse(r#","screen":"a","fps":"60","height":"1080","kbps":null,"keyframeSeconds":[],"encoder":5"#);
        assert_eq!((s.screen, s.fps, s.height, s.kbps, s.keyframe_seconds, s.audio_kbps), (0, 60, 1080, 6000, 2, 160));
        assert_eq!(s.encoder, EncoderChoice::Auto);
    }

    #[test]
    fn reads_the_extras_and_clamps_them() {
        let s = parse(r#","encoder":"NVIDIA","keyframeSeconds":9,"audioKbps":150"#);
        assert_eq!((s.encoder, s.keyframe_seconds, s.audio_kbps), (EncoderChoice::Nvidia, 4, 160));
        assert_eq!(parse(r#","audioKbps":1"#).audio_kbps, 96);
        assert_eq!(parse(r#","encoder":"amd","keyframeSeconds":0"#).keyframe_seconds, 1);
        assert_eq!(parse(r#","encoder":"nonsense""#).encoder, EncoderChoice::Auto);
    }

    #[test]
    fn ignores_fields_it_does_not_know() {
        let s = parse(r#","overlay":{"x":1},"record":"C:\\x.flv""#);
        assert_eq!(s.fps, 60);
    }

    #[test]
    fn needs_an_rtmp_address() {
        for bad in [r#"{}"#, r#"{"url":""}"#, r#"{"url":"http://x/y"}"#, r#"{"url":5}"#, "nonsense", ""] {
            assert!(Settings::from_json(bad).is_err(), "{bad}");
        }
        assert!(Settings::from_json(r#"{"url":"rtmp://127.0.0.1:19350/app/testkey"}"#).is_ok());
    }

    #[test]
    fn takes_only_the_pipes_the_shell_makes() {
        assert!(is_audio_pipe_name(PIPE));
        assert!(is_audio_pipe_name(r"\\.\pipe\uncbox-stream-audio-1a2b3c4d5e6f7a8b1a2b3c4d5e6f7a8b"));
        for bad in [
            r"\\.\pipe\other",
            r"\\.\pipe\uncbox-stream-audio-xyz",
            r"C:\x.raw",
            r"\\.\pipe\uncbox-stream-audio-1a2b3c4d -f flv x",
            r"\\.\pipe\uncbox-stream-audio-1a2b3c",
            r"\\.\pipe\uncbox-stream-audio-1A2B3C4D",
            "",
        ] {
            assert!(!is_audio_pipe_name(bad), "{bad}");
        }
        assert_eq!(parse(&format!(r#","audioPipe":"{}""#, PIPE.replace('\\', "\\\\"))).audio_pipe.as_deref(), Some(PIPE));
        assert!(Settings::from_json(&format!(r#"{{"url":"{URL}","audioPipe":"C:\\x"}}"#)).is_err());
        assert_eq!(parse(r#","audioPipe":"""#).audio_pipe, None);
    }

    #[test]
    fn never_shows_the_address() {
        let s = parse("");
        assert!(!format!("{s:?}").contains("live_"));
        assert!(!redact::redact(&format!("could not open {URL}")).contains("AbCdEf"));
    }

    #[test]
    fn sizes_keep_the_shape_and_stay_even() {
        assert_eq!(target_size(2560, 1440, 1080), (1920, 1080));
        assert_eq!(target_size(2560, 1440, 720), (1280, 720));
        assert_eq!(target_size(2560, 1440, 0), (2560, 1440));
        assert_eq!(target_size(3440, 1440, 1080), (2580, 1080));
        assert_eq!(target_size(1366, 768, 720), (1280, 720));
        assert_eq!(target_size(1921, 1081, 0), (1920, 1080));
        assert_eq!(target_size(1000, 1000, 720), (720, 720));
    }

    #[test]
    fn gop_is_frames_between_keyframes() {
        assert_eq!(parse(r#","fps":30"#).gop(), 60);
        assert_eq!(parse("").gop(), 120);
    }
}
