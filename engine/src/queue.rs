//! The line between encoding and the network.
//!
//! The network thread takes packets from here one at a time. When the connection can't keep up the
//! line grows, and a stream that waits for every packet gets further and further behind real
//! time. So video is thinned out instead: first the pictures nothing else is built from, then (if
//! that isn't enough) everything back to the newest keyframe, and the encoder is asked for a fresh
//! keyframe. Sound is small and never dropped. Every dropped picture is counted, because the page
//! shows "dropped" and a person deciding on a lower bitrate wants to know.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// Backlog (in milliseconds of video waiting) at which throwaway pictures start being dropped.
pub const THIN_AT_MS: i64 = 400;
/// Backlog at which video is cut back to the newest keyframe.
pub const CUT_AT_MS: i64 = 1500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    /// The video sequence header (always first among the video). `audio_shift_ms` is how much later
    /// than capture time the video is shown (B-frames make the encoder delay it), which the sound
    /// is delayed by too so they stay together.
    VideoHeader {
        body: Vec<u8>,
        audio_shift_ms: i64,
    },
    Video {
        dts_ms: i64,
        body: Vec<u8>,
        keyframe: bool,
        reference: bool,
    },
    Audio {
        ts_ms: i64,
        body: Vec<u8>,
    },
}

pub enum Taken {
    Packet(Packet),
    Empty,
    /// Closed and nothing left.
    Done,
}

#[derive(Default)]
struct Inner {
    items: VecDeque<Packet>,
    closed: bool,
    waiting_for_key: bool,
}

#[derive(Default)]
pub struct PacketQueue {
    inner: Mutex<Inner>,
    ready: Condvar,
    /// Video pictures dropped here so far.
    pub dropped: AtomicU64,
    /// Set when the encoder should make a keyframe soon (the line was cut back).
    pub want_keyframe: AtomicBool,
    /// Nothing is ever dropped (a stream written to a file for testing has no slow connection to protect).
    lossless: bool,
}

fn video_backlog_ms(items: &VecDeque<Packet>) -> i64 {
    let mut times = items.iter().filter_map(|p| if let Packet::Video { dts_ms, .. } = p { Some(*dts_ms) } else { None });
    match (times.next(), times.next_back()) {
        (Some(first), Some(last)) => last - first,
        _ => 0,
    }
}

impl PacketQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// A line that never thins out video: for a file, which is never "slow".
    pub fn lossless() -> Self {
        PacketQueue { lossless: true, ..Self::default() }
    }

    pub fn push(&self, packet: Packet) {
        let mut inner = self.inner.lock().expect("queue lock");
        if inner.closed {
            return;
        }
        if self.lossless {
            inner.items.push_back(packet);
            self.ready.notify_one();
            return;
        }
        if let Packet::Video { keyframe, reference, .. } = &packet {
            let (keyframe, reference) = (*keyframe, *reference);
            if inner.waiting_for_key {
                if keyframe {
                    inner.waiting_for_key = false;
                } else {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }
            let backlog = video_backlog_ms(&inner.items);
            if backlog > CUT_AT_MS {
                self.cut_back(&mut inner);
                if !keyframe && inner.waiting_for_key {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            } else if backlog > THIN_AT_MS && !reference {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
        inner.items.push_back(packet);
        self.ready.notify_one();
    }

    /// Drops every waiting picture older than the newest keyframe. When the waiting video is all one
    /// keyframe's worth (the newest keyframe is also the oldest picture), none of it can be kept
    /// without what came before, so all of it goes and the line waits for the next keyframe.
    fn cut_back(&self, inner: &mut Inner) {
        let is_video = |p: &Packet| matches!(p, Packet::Video { .. });
        let oldest = inner.items.iter().position(is_video);
        let newest_key = inner.items.iter().rposition(|p| matches!(p, Packet::Video { keyframe: true, .. })).filter(|key| Some(*key) != oldest);
        let before = inner.items.len();
        let mut index = 0;
        inner.items.retain(|p| {
            let here = index;
            index += 1;
            match (is_video(p), newest_key) {
                (true, Some(key)) => here >= key,
                (true, None) => false,
                (false, _) => true,
            }
        });
        self.dropped.fetch_add((before - inner.items.len()) as u64, Ordering::Relaxed);
        if newest_key.is_none() {
            inner.waiting_for_key = true;
        }
        self.want_keyframe.store(true, Ordering::Relaxed);
    }

    pub fn take(&self, wait: Duration) -> Taken {
        let mut inner = self.inner.lock().expect("queue lock");
        if inner.items.is_empty() && !inner.closed {
            inner = self.ready.wait_timeout(inner, wait).expect("queue lock").0;
        }
        match inner.items.pop_front() {
            Some(p) => Taken::Packet(p),
            None if inner.closed => Taken::Done,
            None => Taken::Empty,
        }
    }

    /// No more packets will be added; what is waiting can still be taken.
    pub fn close(&self) {
        self.inner.lock().expect("queue lock").closed = true;
        self.ready.notify_all();
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("queue lock").items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Sound that waits for the picture to catch up before it is sent.
///
/// An encoder that looks ahead and reorders (B-frames) hands a picture over a few tenths of a second
/// after it was captured, while sound is ready at once. Sent in the order it arrives, the sound would
/// run that far ahead of the picture in the stream, and a server wants both in time stamp order, near
/// enough. So sound waits here until a picture with a later time stamp has gone out, and no longer
/// than [`AUDIO_HOLD`] in any case (if the picture stalls, the sound must not).
#[derive(Debug, Default)]
pub struct AudioHold {
    items: VecDeque<(i64, std::time::Instant, Vec<u8>)>,
}

/// How long sound is held for the picture at the most.
pub const AUDIO_HOLD: Duration = Duration::from_millis(1500);
/// How much later than the newest picture's time stamp sound may be sent, in milliseconds.
pub const AUDIO_SLACK_MS: i64 = 20;

impl AudioHold {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, ts_ms: i64, body: Vec<u8>, now: std::time::Instant) {
        self.items.push_back((ts_ms, now, body));
    }

    /// The sound that may go out now, given the time stamp of the newest picture sent.
    pub fn release(&mut self, video_dts_ms: i64, now: std::time::Instant) -> Vec<(i64, Vec<u8>)> {
        let mut out = Vec::new();
        while let Some((ts, since, _)) = self.items.front() {
            if *ts <= video_dts_ms + AUDIO_SLACK_MS || now.saturating_duration_since(*since) >= AUDIO_HOLD {
                let (ts, _, body) = self.items.pop_front().expect("checked above");
                out.push((ts, body));
            } else {
                break;
            }
        }
        out
    }

    /// Everything still held (the stream is ending).
    pub fn flush(&mut self) -> Vec<(i64, Vec<u8>)> {
        self.items.drain(..).map(|(ts, _, body)| (ts, body)).collect()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(dts_ms: i64, keyframe: bool, reference: bool) -> Packet {
        Packet::Video { dts_ms, body: vec![0; 4], keyframe, reference }
    }

    fn drain(q: &PacketQueue) -> Vec<Packet> {
        let mut out = Vec::new();
        while let Taken::Packet(p) = q.take(Duration::ZERO) {
            out.push(p);
        }
        out
    }

    fn times(packets: &[Packet]) -> Vec<i64> {
        packets.iter().filter_map(|p| if let Packet::Video { dts_ms, .. } = p { Some(*dts_ms) } else { None }).collect()
    }

    #[test]
    fn passes_everything_through_when_the_network_keeps_up() {
        let q = PacketQueue::new();
        q.push(Packet::VideoHeader { body: vec![1], audio_shift_ms: 0 });
        for i in 0..30 {
            q.push(video(i * 16, i == 0, true));
            q.push(Packet::Audio { ts_ms: i * 16, body: vec![1] });
            if i % 2 == 0 {
                drain(&q);
            }
        }
        assert_eq!(q.dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn keeps_the_order_it_was_given() {
        let q = PacketQueue::new();
        q.push(video(0, true, true));
        q.push(Packet::Audio { ts_ms: 3, body: vec![] });
        q.push(video(16, false, true));
        let got = drain(&q);
        assert!(matches!(got[0], Packet::Video { dts_ms: 0, .. }));
        assert!(matches!(got[1], Packet::Audio { ts_ms: 3, .. }));
        assert!(matches!(got[2], Packet::Video { dts_ms: 16, .. }));
    }

    #[test]
    fn drops_throwaway_pictures_first_when_a_backlog_builds() {
        let q = PacketQueue::new();
        q.push(video(0, true, true));
        // 500 ms of waiting video: past the point where pictures nothing depends on are dropped.
        for i in 1..=30 {
            q.push(video(i * 17, false, true));
        }
        let before = q.dropped.load(Ordering::Relaxed);
        q.push(video(600, false, false));
        q.push(video(617, false, true));
        assert_eq!(q.dropped.load(Ordering::Relaxed), before + 1);
        let got = times(&drain(&q));
        assert!(!got.contains(&600) && got.contains(&617));
        assert!(!q.want_keyframe.load(Ordering::Relaxed));
    }

    #[test]
    fn cuts_back_to_the_newest_keyframe_when_it_gets_long() {
        let q = PacketQueue::new();
        q.push(Packet::VideoHeader { body: vec![9], audio_shift_ms: 0 });
        for i in 0..100 {
            // A keyframe every 40 pictures, 20 ms apart.
            q.push(video(i * 20, i % 40 == 0, true));
        }
        let got = drain(&q);
        assert!(matches!(got[0], Packet::VideoHeader { .. }), "the header always stays");
        let kept = times(&got);
        // Whatever was cut, what is left starts at a keyframe and runs in order.
        assert!(kept.windows(2).all(|w| w[0] < w[1]));
        assert!(q.dropped.load(Ordering::Relaxed) > 0);
        assert!(q.want_keyframe.load(Ordering::Relaxed));
        let first = got.iter().find(|p| matches!(p, Packet::Video { .. })).unwrap();
        assert!(matches!(first, Packet::Video { keyframe: true, .. }));
    }

    #[test]
    fn waits_for_a_keyframe_when_there_is_none_to_cut_back_to() {
        let q = PacketQueue::new();
        q.push(video(0, true, true));
        for i in 1..100 {
            q.push(video(i * 20, false, true));
        }
        drain(&q);
        // The line was emptied of video, so the next pictures are useless until a keyframe.
        q.push(video(5000, false, true));
        q.push(video(5020, false, true));
        assert_eq!(times(&drain(&q)), Vec::<i64>::new());
        q.push(video(5040, true, true));
        q.push(video(5060, false, true));
        assert_eq!(times(&drain(&q)), vec![5040, 5060]);
    }

    #[test]
    fn never_drops_sound() {
        let q = PacketQueue::new();
        q.push(video(0, true, true));
        for i in 0..200 {
            q.push(Packet::Audio { ts_ms: i * 10, body: vec![0; 10] });
            q.push(video(i * 20, false, true));
        }
        let audio = drain(&q).iter().filter(|p| matches!(p, Packet::Audio { .. })).count();
        assert_eq!(audio, 200);
    }

    /// What an encoder with two B-frames sends for display order 0..n, as queue packets: the decode
    /// order I0 P3 B1 B2 P6 B4 B5 ..., decode times rising 17 ms apart, the keyframe first. `ref_b`
    /// makes the first B of each pair a reference (B-frames as references).
    fn b_frame_stream(n: i64, gop: i64, ref_b: bool) -> Vec<Packet> {
        let mut order = Vec::new();
        let mut group_start = 0;
        while group_start < n {
            let group_end = (group_start + gop).min(n);
            order.push((group_start, true, true));
            let mut anchor = group_start;
            while anchor + 1 < group_end {
                let next = (anchor + 3).min(group_end - 1);
                order.push((next, false, true));
                for shown in anchor + 1..next {
                    order.push((shown, false, ref_b && shown == anchor + 1 && next - anchor == 3));
                }
                anchor = next;
            }
            group_start = group_end;
        }
        order.iter().enumerate().map(|(decode_index, &(_, key, reference))| video(decode_index as i64 * 17, key, reference)).collect()
    }

    #[test]
    fn with_b_frames_only_pictures_nothing_is_built_from_are_thinned_first() {
        let q = PacketQueue::new();
        q.push(Packet::VideoHeader { body: vec![1], audio_shift_ms: 33 });
        let stream = b_frame_stream(60, 120, true);
        let referenced = stream.iter().filter(|p| matches!(p, Packet::Video { reference: true, .. })).count();
        for p in stream {
            q.push(p);
        }
        let kept = times(&drain(&q));
        // Whatever was thinned, the decode times left still rise.
        assert!(kept.windows(2).all(|w| w[0] < w[1]));
        // And every picture something is built from is still there.
        assert!(kept.len() >= referenced, "{} kept of {referenced} referenced", kept.len());
        assert!(q.dropped.load(Ordering::Relaxed) > 0, "a 1 s backlog is past the point where throwaway pictures go");
    }

    #[test]
    fn a_cut_back_through_b_frames_restarts_at_a_keyframe_with_rising_times() {
        let q = PacketQueue::new();
        q.push(Packet::VideoHeader { body: vec![1], audio_shift_ms: 33 });
        // Four keyframe intervals of 30 pictures in decode order with B-frames: well past 1.5 s waiting.
        for p in b_frame_stream(120, 30, true) {
            q.push(p);
        }
        let got = drain(&q);
        assert!(matches!(got[0], Packet::VideoHeader { .. }));
        let pictures: Vec<&Packet> = got.iter().filter(|p| matches!(p, Packet::Video { .. })).collect();
        assert!(matches!(pictures[0], Packet::Video { keyframe: true, .. }), "what is kept starts at a keyframe");
        let kept = times(&got);
        assert!(kept.windows(2).all(|w| w[0] < w[1]));
        assert!(q.want_keyframe.load(Ordering::Relaxed));
        assert!(q.dropped.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn after_a_cut_the_pictures_before_the_next_keyframe_are_not_sent() {
        let q = PacketQueue::new();
        q.push(video(0, true, true));
        for i in 1..120 {
            q.push(video(i * 17, false, true));
        }
        drain(&q);
        // B-frames of the dropped group arrive: useless without their keyframe.
        q.push(video(3000, false, false));
        q.push(video(3017, false, true));
        assert!(times(&drain(&q)).is_empty());
        q.push(video(3034, true, true));
        q.push(video(3051, false, true));
        q.push(video(3068, false, false));
        assert_eq!(times(&drain(&q)), vec![3034, 3051, 3068]);
    }

    #[test]
    fn a_lossless_line_keeps_every_picture_however_long_it_gets() {
        let q = PacketQueue::lossless();
        for p in b_frame_stream(600, 120, true) {
            q.push(p);
        }
        assert_eq!(times(&drain(&q)).len(), 600);
        assert_eq!(q.dropped.load(Ordering::Relaxed), 0);
        assert!(!q.want_keyframe.load(Ordering::Relaxed));
    }

    #[test]
    fn sound_waits_for_the_picture_that_is_late() {
        let now = std::time::Instant::now();
        let mut hold = AudioHold::new();
        for ts in [0, 10, 20, 30, 40] {
            hold.push(ts, vec![ts as u8], now);
        }
        // No picture yet (-1 ms, with the slack): only what is within 20 ms of nothing.
        assert!(hold.release(-100, now).is_empty());
        // A picture at 15 ms has gone out: sound up to 15 + 20 = 35 may follow.
        let out: Vec<i64> = hold.release(15, now).into_iter().map(|(ts, _)| ts).collect();
        assert_eq!(out, vec![0, 10, 20, 30]);
        assert_eq!(hold.len(), 1);
    }

    #[test]
    fn sound_is_not_held_forever_if_the_picture_stalls() {
        let start = std::time::Instant::now();
        let mut hold = AudioHold::new();
        hold.push(5000, vec![1], start);
        assert!(hold.release(0, start + Duration::from_millis(1000)).is_empty());
        let out = hold.release(0, start + AUDIO_HOLD);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn the_rest_of_the_sound_comes_out_when_the_stream_ends() {
        let now = std::time::Instant::now();
        let mut hold = AudioHold::new();
        hold.push(1, vec![1], now);
        hold.push(2, vec![2], now);
        let rest = hold.flush();
        assert_eq!(rest.iter().map(|(ts, _)| *ts).collect::<Vec<_>>(), vec![1, 2]);
        assert!(hold.is_empty());
    }

    #[test]
    fn take_waits_and_close_ends_it() {
        let q = PacketQueue::new();
        assert!(matches!(q.take(Duration::from_millis(5)), Taken::Empty));
        q.push(video(0, true, true));
        q.close();
        q.push(video(20, false, true));
        assert!(matches!(q.take(Duration::ZERO), Taken::Packet(_)));
        assert!(matches!(q.take(Duration::ZERO), Taken::Done));
    }
}
