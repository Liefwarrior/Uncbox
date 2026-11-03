//! What the NVIDIA encoder is asked for, as plain values, and what happens when an older card or
//! driver turns part of it down.
//!
//! The picture quality of a stream is mostly settled by these. They are the settings of the FFmpeg
//! path (`encoderArgs('nvenc', kbps, fps, 'quality')` in server/stream.mjs, with its `safe` set as
//! the fallback), so a stream looks the same whichever engine makes it:
//!
//! - **quality**: preset P6 with the high-quality tuning, constant bitrate, a first pass at quarter
//!   size (multipass), adaptive quantisation over time (temporal AQ) but not over space, 20 frames
//!   of look-ahead, 2 B-frames with the middle one used as a reference.
//! - **safe**: preset P5 with the same tuning, constant bitrate, 2 B-frames, none of the rest. For
//!   a card or driver that refuses part of the quality set (B-frames as references need an RTX 20
//!   or newer, for one).
//!
//! `nvenc.rs` turns [`NvencParams`] into the driver's structures; nothing here touches the driver.

use crate::settings::TuningChoice;

/// Which set of settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tuning {
    Quality,
    Safe,
}

impl Tuning {
    pub fn name(self) -> &'static str {
        match self {
            Tuning::Quality => "quality",
            Tuning::Safe => "safe",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    P5,
    P6,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Multipass {
    Disabled,
    QuarterResolution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BFrameRef {
    Disabled,
    Middle,
}

/// Everything the NVIDIA encoder session is configured with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NvencParams {
    pub tuning: Tuning,
    pub preset: Preset,
    /// Always constant bitrate; the bitrate is in bits per second.
    pub bitrate: u32,
    pub max_bitrate: u32,
    /// The VBV buffer, in bits: two seconds of the bitrate.
    pub vbv_buffer: u32,
    pub multipass: Multipass,
    pub temporal_aq: bool,
    /// Always off: it made the worst frames worse in the measurements behind the FFmpeg settings.
    pub spatial_aq: bool,
    /// Frames of look-ahead; 0 is none.
    pub lookahead: u32,
    pub bframes: u32,
    pub b_frame_ref: BFrameRef,
    /// Frames between keyframes; every one is an IDR picture.
    pub gop: u32,
    pub fps: u32,
}

/// The settings for a bitrate (kbit/s), frame rate and keyframe interval, with `bframes` B-frames
/// between the pictures other pictures are built from.
pub fn nvenc_params(tuning: Tuning, kbps: u32, fps: u32, keyframe_seconds: u32, bframes: u32) -> NvencParams {
    let bitrate = kbps.saturating_mul(1000);
    let quality = tuning == Tuning::Quality;
    NvencParams {
        tuning,
        preset: if quality { Preset::P6 } else { Preset::P5 },
        bitrate,
        max_bitrate: bitrate,
        vbv_buffer: bitrate.saturating_mul(2),
        multipass: if quality { Multipass::QuarterResolution } else { Multipass::Disabled },
        temporal_aq: quality,
        spatial_aq: false,
        lookahead: if quality { 20 } else { 0 },
        bframes,
        b_frame_ref: if quality && bframes >= 2 { BFrameRef::Middle } else { BFrameRef::Disabled },
        gop: fps.saturating_mul(keyframe_seconds),
        fps,
    }
}

/// The settings to try, in order, until one opens: the asked-for set, then the safe set, then the
/// safe set without B-frames (for a card that has none). `choice` is what the caller asked for;
/// starting at `Safe` skips the quality attempt (the probe already found it refused).
pub fn attempts(choice: TuningChoice, bframes: u32) -> Vec<(Tuning, u32)> {
    let mut list = Vec::new();
    if choice != TuningChoice::Safe {
        list.push((Tuning::Quality, bframes));
    }
    list.push((Tuning::Safe, bframes));
    if bframes > 0 {
        list.push((Tuning::Safe, 0));
    }
    list
}

/// How many pictures the session needs to hold at once: FFmpeg's rule (`nvenc_recalc_surfaces`), so
/// the look-ahead and the B-frame reordering never run out. Input pictures stay with the encoder
/// until their output has been taken, so the engine's picture pool is this plus a few.
pub fn surfaces(lookahead: u32, bframes: u32) -> usize {
    let interval = bframes as usize + 1;
    let base = (interval * 4).max(4);
    if lookahead > 0 {
        base.max(lookahead as usize + interval + 1 + 4)
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quality_set_is_what_ffmpeg_is_asked_for() {
        let p = nvenc_params(Tuning::Quality, 6000, 60, 2, 2);
        assert_eq!(p.preset, Preset::P6);
        assert_eq!((p.bitrate, p.max_bitrate, p.vbv_buffer), (6_000_000, 6_000_000, 12_000_000));
        assert_eq!(p.multipass, Multipass::QuarterResolution);
        assert!(p.temporal_aq);
        assert!(!p.spatial_aq);
        assert_eq!(p.lookahead, 20);
        assert_eq!((p.bframes, p.b_frame_ref), (2, BFrameRef::Middle));
        assert_eq!(p.gop, 120);
        assert_eq!(p.tuning, Tuning::Quality);
    }

    #[test]
    fn the_safe_set_is_p5_with_b_frames_and_nothing_else() {
        let p = nvenc_params(Tuning::Safe, 6000, 60, 2, 2);
        assert_eq!(p.preset, Preset::P5);
        assert_eq!(p.multipass, Multipass::Disabled);
        assert!(!p.temporal_aq && !p.spatial_aq);
        assert_eq!(p.lookahead, 0);
        assert_eq!((p.bframes, p.b_frame_ref), (2, BFrameRef::Disabled));
        assert_eq!((p.bitrate, p.vbv_buffer), (6_000_000, 12_000_000));
        assert_eq!(p.tuning, Tuning::Safe);
    }

    #[test]
    fn the_buffer_is_twice_the_bitrate_and_the_keyframes_are_where_the_settings_say() {
        let p = nvenc_params(Tuning::Quality, 4500, 30, 1, 2);
        assert_eq!((p.bitrate, p.max_bitrate, p.vbv_buffer), (4_500_000, 4_500_000, 9_000_000));
        assert_eq!(p.gop, 30);
        assert_eq!(nvenc_params(Tuning::Quality, 8000, 60, 4, 2).gop, 240);
        assert_eq!(nvenc_params(Tuning::Quality, 8000, 30, 2, 2).vbv_buffer, 16_000_000);
    }

    #[test]
    fn no_b_frames_means_no_b_frame_references() {
        let p = nvenc_params(Tuning::Quality, 6000, 60, 2, 0);
        assert_eq!((p.bframes, p.b_frame_ref), (0, BFrameRef::Disabled));
        // One B-frame has no middle one.
        assert_eq!(nvenc_params(Tuning::Quality, 6000, 60, 2, 1).b_frame_ref, BFrameRef::Disabled);
        assert_eq!(nvenc_params(Tuning::Quality, 6000, 60, 2, 3).b_frame_ref, BFrameRef::Middle);
    }

    #[test]
    fn tries_quality_then_safe_then_safe_without_b_frames() {
        assert_eq!(attempts(TuningChoice::Auto, 2), vec![(Tuning::Quality, 2), (Tuning::Safe, 2), (Tuning::Safe, 0)]);
        assert_eq!(attempts(TuningChoice::Quality, 2), vec![(Tuning::Quality, 2), (Tuning::Safe, 2), (Tuning::Safe, 0)]);
    }

    #[test]
    fn a_caller_that_already_knows_quality_is_refused_starts_at_safe() {
        assert_eq!(attempts(TuningChoice::Safe, 2), vec![(Tuning::Safe, 2), (Tuning::Safe, 0)]);
        assert_eq!(attempts(TuningChoice::Safe, 3), vec![(Tuning::Safe, 3), (Tuning::Safe, 0)]);
    }

    #[test]
    fn without_b_frames_there_is_nothing_to_drop() {
        assert_eq!(attempts(TuningChoice::Auto, 0), vec![(Tuning::Quality, 0), (Tuning::Safe, 0)]);
        assert_eq!(attempts(TuningChoice::Safe, 0), vec![(Tuning::Safe, 0)]);
    }

    #[test]
    fn the_first_attempt_that_opens_wins_and_is_the_one_reported() {
        // A card that takes the quality set.
        let plan = attempts(TuningChoice::Auto, 2);
        let won = plan.iter().find(|a| ok_on("new card", **a));
        assert_eq!(won, Some(&(Tuning::Quality, 2)));
        // An older card: no B-frames as references or look-ahead.
        let won = plan.iter().find(|a| ok_on("older card", **a));
        assert_eq!(won, Some(&(Tuning::Safe, 2)));
        // A card with no B-frames at all.
        let won = plan.iter().find(|a| ok_on("no b-frames", **a));
        assert_eq!(won, Some(&(Tuning::Safe, 0)));
        // A card that refuses everything.
        assert_eq!(plan.iter().find(|a| ok_on("nothing", **a)), None);
    }

    /// Stands in for opening a session: which attempts each kind of card takes.
    fn ok_on(card: &str, attempt: (Tuning, u32)) -> bool {
        match card {
            "new card" => true,
            "older card" => attempt.0 == Tuning::Safe,
            "no b-frames" => attempt.0 == Tuning::Safe && attempt.1 == 0,
            _ => false,
        }
    }

    #[test]
    fn the_picture_count_follows_ffmpeg() {
        // Quality: 20 + 3 + 1 + 4.
        assert_eq!(surfaces(20, 2), 28);
        // Safe with B-frames: 4 x the interval.
        assert_eq!(surfaces(0, 2), 12);
        assert_eq!(surfaces(0, 0), 4);
        assert_eq!(surfaces(20, 0), 26);
        assert_eq!(surfaces(20, 3), 29);
    }
}
