//! Uncbox's own streaming engine: capture a screen, encode it on the graphics card, and send it
//! (with the app's sound) to Twitch over RTMP. `src/main.rs` is the program; this is its parts.
//!
//! The parts that are only data (settings, the stream key filter, FLV, H.264 NAL units, AMF0, the
//! RTMP chunking, the packet line) don't touch Windows and are tested on their own. The parts that
//! talk to the graphics card, Media Foundation and the sound pipe are Windows-only.

pub mod amf0;
pub mod error;
pub mod flv;
pub mod h264;
pub mod log;
pub mod net;
pub mod progress;
pub mod queue;
pub mod redact;
pub mod rtmp;
pub mod settings;

#[cfg(windows)]
pub mod audio;
#[cfg(windows)]
pub mod capture;
#[cfg(windows)]
pub mod convert;
#[cfg(windows)]
pub mod gpu;
#[cfg(windows)]
pub mod mf;
#[cfg(windows)]
pub mod pipeline;
