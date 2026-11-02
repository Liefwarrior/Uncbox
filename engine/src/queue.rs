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

    pub fn push(&self, packet: Packet) {
        let mut inner = self.inner.lock().expect("queue lock");
        if inner.closed {
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
