//! The once-a-second report on stdout, in the format FFmpeg's `-progress` prints, so the server's
//! `createProgressParser()` (server/stream.mjs) reads it without changes. A block is `key=value`
//! lines ending in `progress=continue` (or `progress=end` as the engine exits).

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    /// Video frames sent so far.
    pub frames: u64,
    /// Frames per second over the last few seconds.
    pub fps: f64,
    /// Video and sound sent over the last few seconds, in kbit/s.
    pub bitrate_kbps: f64,
    /// Bytes handed to the network so far.
    pub total_size: u64,
    /// How much stream time has been sent, in microseconds.
    pub out_time_us: i64,
    /// Frames repeated because the screen had not changed.
    pub dup_frames: u64,
    /// Frames lost: skipped by a slow capture, or dropped because the connection was too slow.
    pub drop_frames: u64,
    /// Stream time divided by clock time: 1.00 is exactly real time.
    pub speed: f64,
}

fn clock_text(us: i64) -> String {
    let us = us.max(0);
    let total_seconds = us / 1_000_000;
    format!("{:02}:{:02}:{:02}.{:06}", total_seconds / 3600, (total_seconds / 60) % 60, total_seconds % 60, us % 1_000_000)
}

impl Progress {
    /// One block. `last` ends it with `progress=end` instead of `progress=continue`.
    pub fn block(&self, last: bool) -> String {
        format!(
            "frame={}\nfps={:.2}\nbitrate={:.1}kbits/s\ntotal_size={}\nout_time_us={}\nout_time_ms={}\nout_time={}\ndup_frames={}\ndrop_frames={}\nspeed={:.2}x\nprogress={}\n",
            self.frames,
            self.fps,
            self.bitrate_kbps,
            self.total_size,
            self.out_time_us.max(0),
            self.out_time_us.max(0),
            clock_text(self.out_time_us),
            self.dup_frames,
            self.drop_frames,
            self.speed,
            if last { "end" } else { "continue" },
        )
    }
}

/// Averages the bytes sent over a sliding window, so the bitrate shown is steady rather than
/// jumping with every keyframe.
#[derive(Debug)]
pub struct RateWindow {
    window_us: i64,
    samples: std::collections::VecDeque<(i64, u64)>,
}

impl RateWindow {
    pub fn new(window_seconds: i64) -> Self {
        RateWindow { window_us: window_seconds * 1_000_000, samples: Default::default() }
    }

    /// Notes that `total` bytes had been sent at `at_us`, and returns the average rate in kbit/s over the window.
    pub fn push(&mut self, at_us: i64, total: u64) -> f64 {
        self.samples.push_back((at_us, total));
        while self.samples.len() > 2 && at_us - self.samples[1].0 >= self.window_us {
            self.samples.pop_front();
        }
        let (t0, b0) = self.samples[0];
        let dt = (at_us - t0) as f64 / 1_000_000.0;
        if dt <= 0.0 {
            0.0
        } else {
            (total.saturating_sub(b0)) as f64 * 8.0 / 1000.0 / dt
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Progress {
        Progress { frames: 295, fps: 59.94, bitrate_kbps: 5876.3, total_size: 3_145_728, out_time_us: 4_433_333, dup_frames: 4, drop_frames: 2, speed: 0.998 }
    }

    #[test]
    fn prints_what_ffmpeg_prints() {
        let text = sample().block(false);
        assert_eq!(
            text,
            "frame=295\nfps=59.94\nbitrate=5876.3kbits/s\ntotal_size=3145728\nout_time_us=4433333\nout_time_ms=4433333\nout_time=00:00:04.433333\ndup_frames=4\ndrop_frames=2\nspeed=1.00x\nprogress=continue\n"
        );
    }

    #[test]
    fn ends_with_end_on_the_last_block() {
        assert!(sample().block(true).ends_with("progress=end\n"));
    }

    #[test]
    fn clock_text_counts_hours() {
        assert_eq!(clock_text(3_723_500_000), "01:02:03.500000");
        assert_eq!(clock_text(-5), "00:00:00.000000");
    }

    #[test]
    fn the_rate_follows_a_window() {
        let mut w = RateWindow::new(2);
        assert_eq!(w.push(0, 0), 0.0);
        // 750 000 bytes in one second is 6000 kbit/s.
        assert!((w.push(1_000_000, 750_000) - 6000.0).abs() < 0.01);
        assert!((w.push(2_000_000, 1_500_000) - 6000.0).abs() < 0.01);
        // The stream goes quiet: the average falls as the window moves on.
        let later = w.push(4_000_000, 1_500_000);
        assert!(later < 3100.0, "{later}");
    }
}
