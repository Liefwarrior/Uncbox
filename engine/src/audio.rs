//! The stream's sound: read from the Uncbox app's named pipe (or silence when there is none), kept
//! in step with the picture by the same clock, and encoded as AAC.
//!
//! The pipe carries 32-bit float, 48 kHz, stereo, with no header, written by the app in real time
//! (see native/UncboxShell/StreamAudio.cs). A reader thread takes it in 10 ms blocks. The sound
//! thread then watches the clock: if the pipe goes quiet, silence is filled in so the sound never
//! falls behind the picture; if a late burst arrives after that, the blocks that would put the
//! sound ahead are dropped. If the pipe closes, the stream carries on with silence, as FFmpeg's does:
//! the page hears from the app that its sound stopped and ends the stream itself, with the same words
//! whichever program is streaming.

use crate::error::{Error, Result};
use crate::flv::{self, AacPacket};
use crate::mf::{AudioEncoder, AAC_FRAME_SAMPLES, SAMPLE_RATE};
use crate::queue::{Packet, PacketQueue};
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Frames (one sample for each ear) in the 10 ms blocks the pipe is read in.
pub const BLOCK_FRAMES: usize = 480;
const BLOCK_BYTES: usize = BLOCK_FRAMES * 2 * 4;
/// How far behind the clock the sound may fall before silence is put in.
const STALL_FRAMES: i64 = (SAMPLE_RATE as i64) / 50; // 20 ms
/// How far ahead of the clock the sound may get before blocks are dropped.
const AHEAD_FRAMES: i64 = (SAMPLE_RATE as i64) / 12; // about 80 ms

enum FromPipe {
    Block(Vec<f32>),
    Closed(String),
}

pub fn open_pipe(name: &str) -> Result<std::fs::File> {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        match std::fs::OpenOptions::new().read(true).open(name) {
            Ok(file) => return Ok(file),
            Err(e) => {
                // Not made yet (2) or its one connection is taken (231): wait a moment and try again.
                let busy = matches!(e.raw_os_error(), Some(2) | Some(231));
                if !busy || Instant::now() > deadline {
                    return Err(Error::new(if busy { "Uncbox's sound pipe didn't open in time." } else { "Couldn't open Uncbox's sound pipe." }));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// A thread reading blocks from the pipe, as soon as it is opened.
fn spawn_reader(mut file: std::fs::File) -> Receiver<FromPipe> {
    let (tx, rx) = sync_channel(256);
    std::thread::Builder::new()
        .name("sound pipe".into())
        .spawn(move || {
            let mut bytes = [0u8; BLOCK_BYTES];
            loop {
                if let Err(e) = file.read_exact(&mut bytes) {
                    let why = if e.kind() == std::io::ErrorKind::UnexpectedEof || e.raw_os_error() == Some(109) {
                        "The Uncbox app stopped sending sound.".to_string()
                    } else {
                        format!("Reading the sound failed: {e}")
                    };
                    let _ = tx.send(FromPipe::Closed(why));
                    return;
                }
                let block: Vec<f32> = bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
                if tx.send(FromPipe::Block(block)).is_err() {
                    return;
                }
            }
        })
        .expect("spawn sound pipe reader");
    rx
}

/// 32-bit float to 16-bit, with the clipping a loud mix needs.
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16).collect()
}

/// The 100 ns timestamp of the sample at `frames` into the stream.
fn ticks(frames: u64) -> i64 {
    (frames * 10_000_000 / u64::from(SAMPLE_RATE)) as i64
}

/// Counters the sound thread keeps for the report.
#[derive(Default)]
pub struct AudioStats {
    /// Blocks of silence put in because the pipe was quiet.
    pub filled_blocks: AtomicU64,
    /// Blocks dropped because they would have put the sound ahead of the picture.
    pub dropped_blocks: AtomicU64,
}

pub struct AudioParams {
    pub pipe: Option<std::fs::File>,
    pub kbps: u32,
    pub start: Instant,
    pub stop: Arc<AtomicBool>,
}

/// Runs the sound until `stop` is set; returns an error if the encoder fails. `note` gets remarks
/// for whoever works on the engine (a stall, the pipe closing); they are not reasons to stop.
pub fn run(params: AudioParams, queue: Arc<PacketQueue>, stats: Arc<AudioStats>, note: impl Fn(&str)) -> Result<()> {
    crate::mf::init_thread();
    let mut encoder = AudioEncoder::new(params.kbps)?;
    // The two-byte "how to decode this" note goes before any sound.
    queue.push(Packet::Audio { ts_ms: 0, body: flv::audio_body(AacPacket::SequenceHeader, &flv::aac_config(SAMPLE_RATE, 2)) });

    let mut reader = params.pipe.map(spawn_reader);
    // The clock started when the pipe was opened, so the app's real-time writer and ours agree.
    let start = params.start;
    let mut frames_in: u64 = 0;
    let mut frames_sent: u64 = 0;
    let mut aac_frames: Vec<Vec<u8>> = Vec::new();
    let mut last_warning: Option<Instant> = None;
    let mut note_stall = |text: &str| {
        if last_warning.is_none_or(|t| t.elapsed() > Duration::from_secs(10)) {
            last_warning = Some(Instant::now());
            note(text);
        }
    };
    // How long, in a row, silence has been put in because the pipe said nothing.
    let mut silent_run: u64 = 0;

    let deliver = |encoder: &mut AudioEncoder, block: &[f32], frames_in: &mut u64, aac: &mut Vec<Vec<u8>>| -> Result<()> {
        encoder.encode(&to_i16(block), ticks(*frames_in), aac)?;
        *frames_in += (block.len() / 2) as u64;
        Ok(())
    };
    let silence = vec![0f32; BLOCK_FRAMES * 2];

    while !params.stop.load(Ordering::Relaxed) {
        let elapsed_frames = (start.elapsed().as_secs_f64() * f64::from(SAMPLE_RATE)) as i64;
        let wait = Duration::from_millis(5);
        let got = match &reader {
            Some(rx) => match rx.recv_timeout(wait) {
                Ok(msg) => Some(msg),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => Some(FromPipe::Closed("The Uncbox app stopped sending sound.".into())),
            },
            None => {
                std::thread::sleep(wait);
                None
            }
        };
        let got_block = matches!(got, Some(FromPipe::Block(_)));
        match got {
            Some(FromPipe::Closed(why)) => {
                // Silence from here on (see the top of this file).
                note(&format!("{why} Going on with silence."));
                reader = None;
            }
            Some(FromPipe::Block(block)) => {
                let ahead = frames_in as i64 + (block.len() / 2) as i64 - elapsed_frames;
                if ahead > AHEAD_FRAMES {
                    stats.dropped_blocks.fetch_add(1, Ordering::Relaxed);
                } else {
                    deliver(&mut encoder, &block, &mut frames_in, &mut aac_frames)?;
                }
            }
            None => {}
        }
        // If the sound is more than a moment behind the clock, fill the gap with silence.
        let mut guard = 0;
        if got_block {
            silent_run = 0;
        }
        while (elapsed_frames - frames_in as i64) > STALL_FRAMES && guard < 400 {
            silent_run += BLOCK_FRAMES as u64;
            // A gap of a fifth of a second or more is worth a word; a hiccup at the start is not.
            if reader.is_some() && silent_run >= u64::from(SAMPLE_RATE) / 5 && start.elapsed() > Duration::from_secs(2) {
                note_stall("The sound stalled for a moment; filling it with silence.");
            }
            stats.filled_blocks.fetch_add(1, Ordering::Relaxed);
            deliver(&mut encoder, &silence, &mut frames_in, &mut aac_frames)?;
            guard += 1;
            // Real sound that arrived meanwhile goes next, so stop filling once the pipe has some.
            if let Some(rx) = &reader {
                if rx.try_recv().map(|m| matches!(m, FromPipe::Block(_))).unwrap_or(false) {
                    break;
                }
            }
        }
        for frame in aac_frames.drain(..) {
            let ts_ms = ((frames_sent * AAC_FRAME_SAMPLES * 1000) / u64::from(SAMPLE_RATE)) as i64;
            frames_sent += 1;
            queue.push(Packet::Audio { ts_ms, body: flv::audio_body(AacPacket::Raw, &frame) });
        }
    }

    // Stopping: let the encoder give back what it was holding.
    let mut rest = Vec::new();
    encoder.drain(&mut rest);
    for frame in rest {
        let ts_ms = ((frames_sent * AAC_FRAME_SAMPLES * 1000) / u64::from(SAMPLE_RATE)) as i64;
        frames_sent += 1;
        queue.push(Packet::Audio { ts_ms, body: flv::audio_body(AacPacket::Raw, &frame) });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_float_sound_to_16_bit_with_clipping() {
        assert_eq!(to_i16(&[0.0, 1.0, -1.0, 2.5, -9.0, 0.5]), vec![0, 32767, -32767, 32767, -32767, 16384]);
    }

    #[test]
    fn times_follow_the_sample_count() {
        assert_eq!(ticks(0), 0);
        assert_eq!(ticks(48_000), 10_000_000);
        assert_eq!(ticks(480), 100_000);
    }
}
