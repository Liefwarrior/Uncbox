//! The video encoder, whichever kind it is.
//!
//! NVIDIA cards are driven directly (`nvenc.rs`), which is what gives the picture FFmpeg's
//! `h264_nvenc` gives: B-frames, look-ahead, a first pass at quarter size. AMD and Intel cards (and
//! an NVIDIA card whose direct encoder won't open) go through Media Foundation (`mf.rs`), with as
//! much of FFmpeg's `h264_amf` / `h264_qsv` quality settings as that interface has. This file
//! chooses between them and gives the pipeline one way to talk to either.

use crate::convert::{Picture, PictureReleaser};
use crate::error::{Context, Error, Result};
use crate::gpu::{self, AdapterInfo, Gpu};
use crate::log::{debug, warn};
use crate::mf::{self, EncodedVideo, HardwareEncoder, VideoConfig, VideoEncoder};
use crate::nvenc::{self, Nvenc};
use crate::settings::{Backend, EncoderChoice, Settings, TuningChoice};
use crate::tuning::{self, Tuning};
use std::collections::VecDeque;
use std::time::Duration;

/// Pictures a Media Foundation encoder may still be reading after they were handed over. It doesn't
/// say when it is done with one, so one is let go only this many pictures later.
const MF_HOLD: usize = 8;
/// Pictures in the pool for Media Foundation: those held, those waiting in line, the one being made.
pub const MF_POOL: usize = MF_HOLD + 6;
/// More than the encoder's own pictures: those waiting in line, the one being made.
const NVENC_POOL_EXTRA: usize = 6;

enum Inner {
    Nvenc(Box<Nvenc>),
    Mf { encoder: Box<VideoEncoder>, held: VecDeque<usize> },
}

pub struct Encoder {
    inner: Inner,
    releaser: Option<PictureReleaser>,
    /// "NVIDIA NVENC", or what Media Foundation calls the encoder.
    pub label: String,
    /// `nvenc` or `mediafoundation`.
    pub backend: &'static str,
    /// Which settings NVENC runs with; `None` for Media Foundation.
    pub tuning: Option<Tuning>,
    /// B-frames in use (0 for none).
    pub bframes: u32,
    /// What a Media Foundation encoder turned down.
    pub refused: Vec<&'static str>,
    force_keyframe: bool,
    freed: Vec<usize>,
    /// How many pictures the pool has to hold for this encoder.
    pub pool: usize,
}

/// Names the encoder for a person.
fn nvenc_label(adapter: &AdapterInfo) -> String {
    // "NVIDIA GeForce RTX 5090 Laptop GPU" already says it; others get the maker in front.
    if adapter.name.to_ascii_lowercase().contains("nvidia") {
        format!("{} NVENC", adapter.name)
    } else {
        format!("NVIDIA {} NVENC", adapter.name)
    }
}

/// Refuses an encoder the person asked for that isn't on the card the screen is on.
pub fn check_vendor(choice: EncoderChoice, adapter: &AdapterInfo) -> Result<()> {
    let vendor = gpu::vendor_name(adapter.vendor_id);
    if choice != EncoderChoice::Auto && choice.name() != vendor {
        return Err(Error::new(format!(
            "You asked for the {} encoder, but this screen is on {} graphics ({}). Use Automatic.",
            choice.name(),
            vendor,
            adapter.name
        )));
    }
    Ok(())
}

/// Which Media Foundation encoder runs the picture for this screen, or why none can.
pub fn choose_encoder(choice: EncoderChoice, adapter: &AdapterInfo) -> Result<HardwareEncoder> {
    check_vendor(choice, adapter)?;
    mf::hardware_h264_encoders(adapter.luid, gpu::vendor_name(adapter.vendor_id)).into_iter().next().ok_or_else(|| {
        Error::new(format!("{} has no video encoder Uncbox can use. It needs a recent NVIDIA, AMD or Intel graphics card with current drivers.", adapter.name))
    })
}

impl Encoder {
    /// Opens the best encoder the card has for pictures of `out` size. `settings` says what was asked
    /// for (bitrate, B-frames, a particular backend or set of settings).
    pub fn open(gpu: &Gpu, adapter: &AdapterInfo, settings: &Settings, out: (u32, u32)) -> Result<Encoder> {
        check_vendor(settings.encoder, adapter)?;
        let vendor = gpu::vendor_name(adapter.vendor_id);
        if settings.backend == Backend::Nvenc && vendor != "nvidia" {
            return Err(Error::new(format!("The direct NVIDIA encoder was asked for, but this screen is on {vendor} graphics ({}).", adapter.name)));
        }
        if vendor == "nvidia" && settings.backend != Backend::MediaFoundation {
            match Self::open_nvenc(gpu, adapter, settings, out) {
                Ok(encoder) => return Ok(encoder),
                Err(e) if settings.backend == Backend::Nvenc => return Err(e),
                Err(e) => {
                    warn(&format!("The NVIDIA encoder couldn't be opened directly ({e}), so Windows' media services will do it, with a plainer picture."))
                }
            }
        }
        Self::open_media_foundation(gpu, adapter, settings, out)
    }

    fn open_nvenc(gpu: &Gpu, adapter: &AdapterInfo, settings: &Settings, out: (u32, u32)) -> Result<Encoder> {
        let mut last_error = None;
        for (tuning, bframes) in tuning::attempts(settings.tuning, settings.bframes) {
            let params = tuning::nvenc_params(tuning, settings.kbps, settings.fps, settings.keyframe_seconds, bframes);
            // Try the set on a tiny clip first: a card that refuses it says so there, cheaply.
            let opened = nvenc::self_test(&gpu.device, &params).and_then(|()| Nvenc::open(&gpu.device, out.0, out.1, &params));
            match opened {
                Ok(session) => {
                    debug(&format!("NVENC: {} settings with {bframes} B-frames, {} pictures", tuning.name(), session.surface_count));
                    let pool = session.surface_count + NVENC_POOL_EXTRA;
                    return Ok(Encoder {
                        inner: Inner::Nvenc(Box::new(session)),
                        releaser: None,
                        label: nvenc_label(adapter),
                        backend: "nvenc",
                        tuning: Some(tuning),
                        bframes,
                        refused: Vec::new(),
                        force_keyframe: false,
                        freed: Vec::new(),
                        pool,
                    });
                }
                Err(e) => {
                    debug(&format!("NVENC {} settings with {bframes} B-frames refused: {e}", tuning.name()));
                    last_error = Some(e);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| Error::new("The NVIDIA encoder couldn't be opened.")))
    }

    fn open_media_foundation(gpu: &Gpu, adapter: &AdapterInfo, settings: &Settings, out: (u32, u32)) -> Result<Encoder> {
        let hardware = choose_encoder(settings.encoder, adapter)?;
        let config = mf_config(settings, out, settings.bframes);
        let encoder = VideoEncoder::new(gpu, &hardware, &config).or_else(|first| {
            // Some encoders refuse the B-frame setting outright: try again without.
            if settings.bframes > 0 {
                VideoEncoder::new(gpu, &hardware, &VideoConfig { bframes: 0, ..config.clone() })
            } else {
                Err(first)
            }
        })?;
        debug(&format!("encoder {} (async: {}, b-frames: {})", encoder.name, encoder.is_async, encoder.bframes));
        if !encoder.refused.is_empty() {
            warn(&format!("The video encoder ({}) didn't take: {}.", encoder.name, encoder.refused.join(", ")));
        }
        Ok(Encoder {
            label: encoder.name.clone(),
            backend: "mediafoundation",
            tuning: None,
            bframes: encoder.bframes,
            refused: encoder.refused.clone(),
            inner: Inner::Mf { encoder: Box::new(encoder), held: VecDeque::new() },
            releaser: None,
            force_keyframe: false,
            freed: Vec::new(),
            pool: MF_POOL,
        })
    }

    /// Where finished pictures go back to (the converter's pool).
    pub fn set_releaser(&mut self, releaser: PictureReleaser) {
        self.releaser = Some(releaser);
    }

    fn release(&mut self, token: usize) {
        if let Some(r) = &self.releaser {
            r.release(token);
        }
    }

    fn release_freed(&mut self) {
        for token in std::mem::take(&mut self.freed) {
            self.release(token);
        }
    }

    /// Whether the encoder is waiting for a picture.
    pub fn wants_input(&self) -> bool {
        match &self.inner {
            Inner::Nvenc(_) => true,
            Inner::Mf { encoder, .. } => encoder.wants_input(),
        }
    }

    /// Collects what a Media Foundation encoder has ready (NVENC hands pictures over as they go in).
    pub fn poll(&mut self, out: &mut Vec<EncodedVideo>) -> Result<()> {
        match &mut self.inner {
            Inner::Nvenc(_) => Ok(()),
            Inner::Mf { encoder, .. } => encoder.poll(out),
        }
    }

    /// Makes the next picture a keyframe.
    pub fn force_keyframe(&mut self) {
        match &self.inner {
            Inner::Nvenc(_) => self.force_keyframe = true,
            Inner::Mf { encoder, .. } => encoder.force_keyframe(),
        }
    }

    /// Hands the encoder a picture, shown at `pts` (100 ns units); finished pictures are added to `out`.
    pub fn feed(&mut self, picture: &Picture, pts: i64, duration: i64, out: &mut Vec<EncodedVideo>) -> Result<()> {
        match &mut self.inner {
            Inner::Nvenc(session) => {
                let force = std::mem::take(&mut self.force_keyframe);
                session.feed(&picture.texture, picture.token, pts, force, out)?;
                session.take_released(&mut self.freed);
            }
            Inner::Mf { encoder, held } => {
                let sample = VideoEncoder::sample_for(&picture.texture, pts, duration).context("Couldn't hand a picture to the video encoder")?;
                encoder.feed(&sample, out)?;
                held.push_back(picture.token);
                while held.len() > MF_HOLD {
                    if let Some(token) = held.pop_front() {
                        self.freed.push(token);
                    }
                }
            }
        }
        self.release_freed();
        Ok(())
    }

    /// Ends the stream: everything the encoder still holds comes out, and its pictures are let go.
    pub fn finish(&mut self, out: &mut Vec<EncodedVideo>) -> Result<()> {
        match &mut self.inner {
            Inner::Nvenc(session) => {
                session.finish(out)?;
                session.take_released(&mut self.freed);
            }
            Inner::Mf { encoder, held } => {
                encoder.drain(out, Duration::from_millis(500));
                self.freed.extend(held.drain(..));
            }
        }
        self.release_freed();
        Ok(())
    }
}

/// Puts a short clip of tiny pictures through a Media Foundation encoder and checks that a stream
/// comes out (for the probe: "the driver is installed" isn't "it encodes"). Returns the B-frames the
/// encoder accepted.
pub fn mf_self_test(gpu: &Gpu, hardware: &HardwareEncoder, config: &VideoConfig) -> Result<u32> {
    let mut encoder = VideoEncoder::new(gpu, hardware, config)?;
    let pictures = [nvenc::test_picture(&gpu.device, config.width, config.height, 0)?, nvenc::test_picture(&gpu.device, config.width, config.height, 5)?];
    let frame = 10_000_000 / i64::from(config.fps.max(1));
    let mut out = Vec::new();
    let started = std::time::Instant::now();
    for i in 0..16usize {
        // An asynchronous encoder asks for each picture; give it a moment.
        while !encoder.wants_input() {
            encoder.poll(&mut out)?;
            if started.elapsed() > Duration::from_secs(1) {
                return Err(Error::new("The video encoder stopped asking for pictures."));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let sample = VideoEncoder::sample_for(&pictures[i % 2], i as i64 * frame, frame)?;
        encoder.feed(&sample, &mut out)?;
        encoder.poll(&mut out)?;
    }
    encoder.drain(&mut out, Duration::from_millis(500));
    let first = out.iter().find(|e| crate::h264::annexb_to_avcc(&e.data).keyframe);
    if first.is_none() {
        return Err(Error::new("The video encoder made no keyframe."));
    }
    Ok(encoder.bframes)
}

/// The Media Foundation settings for a stream. With the quality settings (the default) the encoder is
/// asked for its best picture, as FFmpeg's `-quality quality` / `-preset slower` do; the safe set
/// keeps the person's own `quality` number.
pub fn mf_config(settings: &Settings, out: (u32, u32), bframes: u32) -> VideoConfig {
    VideoConfig {
        width: out.0,
        height: out.1,
        fps: settings.fps,
        kbps: settings.kbps,
        gop: settings.gop(),
        bframes,
        quality: if settings.tuning == TuningChoice::Safe { settings.quality } else { 100 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(vendor_id: u32, name: &str) -> AdapterInfo {
        AdapterInfo { index: 0, name: name.into(), vendor_id, luid: windows::Win32::Foundation::LUID::default(), outputs: vec![] }
    }

    #[test]
    fn picks_an_encoder_by_name_only_when_the_screen_is_on_that_makers_card() {
        let err = choose_encoder(EncoderChoice::Amd, &adapter(0x10DE, "Test GPU")).err().expect("should refuse");
        assert!(err.message().contains("amd") && err.message().contains("nvidia"), "{err}");
        assert!(check_vendor(EncoderChoice::Auto, &adapter(0x1002, "Radeon")).is_ok());
        assert!(check_vendor(EncoderChoice::Nvidia, &adapter(0x10DE, "GeForce")).is_ok());
        assert!(check_vendor(EncoderChoice::Intel, &adapter(0x10DE, "GeForce")).is_err());
    }

    #[test]
    fn names_the_nvidia_encoder_once() {
        assert_eq!(nvenc_label(&adapter(0x10DE, "NVIDIA GeForce RTX 5090 Laptop GPU")), "NVIDIA GeForce RTX 5090 Laptop GPU NVENC");
        assert_eq!(nvenc_label(&adapter(0x10DE, "GeForce GTX 1060")), "NVIDIA GeForce GTX 1060 NVENC");
    }

    #[test]
    fn media_foundation_is_asked_for_its_best_picture_unless_the_safe_set_was_chosen() {
        let s = Settings::from_json(r#"{"url":"file:C:/o.flv","quality":60,"kbps":4000,"fps":30}"#).unwrap();
        let c = mf_config(&s, (1280, 720), 2);
        assert_eq!((c.width, c.height, c.fps, c.kbps, c.gop, c.bframes, c.quality), (1280, 720, 30, 4000, 60, 2, 100));
        let s = Settings::from_json(r#"{"url":"file:C:/o.flv","quality":60,"tuning":"safe"}"#).unwrap();
        assert_eq!(mf_config(&s, (1280, 720), 0).quality, 60);
    }
}
