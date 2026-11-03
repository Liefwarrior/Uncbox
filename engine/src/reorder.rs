//! Decode times for an encoder that reorders pictures (B-frames).
//!
//! A picture is shown (its presentation time stamp, PTS) later or earlier than it is decoded (its
//! decode time stamp, DTS) when B-frames are used: the encoder sends a picture that comes later in
//! the show before the B-frames that need it. NVIDIA's encoder hands back the PTS it was given
//! with each picture but no DTS, so this works one out the way FFmpeg does:
//!
//! - Pictures leave the encoder in decode order, and a picture is never decoded more than `delay`
//!   places later than it is shown, `delay` being the number of B-frames. So the decode time of the
//!   n-th picture out can be the PTS of the (n - delay)-th picture in.
//! - The first `delay` pictures out have no such partner: they get times one frame apart ending
//!   just before the first PTS. That is negative stream time, which the muxer shifts away.
//!
//! This keeps DTS strictly rising and never later than the PTS of the same picture, whatever the
//! encoder's choice of B-frame pattern (and when whole slots of time were skipped, the gaps
//! carry through).

use std::collections::VecDeque;

#[derive(Debug)]
pub struct DtsClock {
    delay: u32,
    frame_ticks: i64,
    inputs: VecDeque<i64>,
    total_in: u64,
    out: u64,
}

impl DtsClock {
    /// `delay`: B-frames between reference pictures (0 means pictures leave in the order they went in).
    /// `frame_ticks`: the length of one frame in the same unit as the PTS.
    pub fn new(delay: u32, frame_ticks: i64) -> Self {
        DtsClock { delay, frame_ticks, inputs: VecDeque::new(), total_in: 0, out: 0 }
    }

    /// A picture went in with this PTS.
    pub fn picture_in(&mut self, pts: i64) {
        self.inputs.push_back(pts);
        self.total_in += 1;
    }

    /// A picture came out: its decode time. `None` if more came out than went in (which a working encoder doesn't do).
    pub fn picture_out(&mut self) -> Option<i64> {
        if self.out >= self.total_in {
            return None;
        }
        let n = self.out;
        self.out += 1;
        if n < u64::from(self.delay) {
            let first = *self.inputs.front()?;
            Some(first - (i64::from(self.delay) - n as i64) * self.frame_ticks)
        } else {
            self.inputs.pop_front()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const F: i64 = 166_667;

    /// The order a 2-B-frame encoder sends pictures in for the display order 0..n: I0 P3 B1 B2 P6 B4 B5...
    fn decode_order(n: i64, bframes: i64) -> Vec<i64> {
        let step = bframes + 1;
        let mut order = vec![0];
        let mut anchor = 0;
        while anchor + 1 < n {
            let next = (anchor + step).min(n - 1);
            order.push(next);
            order.extend(anchor + 1..next);
            anchor = next;
        }
        order
    }

    fn run(delay: u32, order: &[i64]) -> Vec<(i64, i64)> {
        let mut clock = DtsClock::new(delay, F);
        for i in 0..order.len() as i64 {
            clock.picture_in(i * F);
        }
        order.iter().map(|&shown| (clock.picture_out().unwrap(), shown * F)).collect()
    }

    #[test]
    fn without_b_frames_decode_time_is_show_time() {
        let times = run(0, &decode_order(10, 0));
        assert!(times.iter().all(|(dts, pts)| dts == pts));
    }

    #[test]
    fn with_two_b_frames_decode_never_comes_after_show_and_always_rises() {
        let order = decode_order(30, 2);
        assert_eq!(&order[..7], &[0, 3, 1, 2, 6, 4, 5]);
        let times = run(2, &order);
        let mut last = i64::MIN;
        for (dts, pts) in &times {
            assert!(*dts > last, "decode times rise: {dts} after {last}");
            assert!(dts <= pts, "decoded no later than shown: dts {dts} pts {pts}");
            last = *dts;
        }
    }

    #[test]
    fn the_first_pictures_start_before_zero_by_a_frame_each() {
        let times = run(2, &decode_order(8, 2));
        assert_eq!(times[0].0, -2 * F);
        assert_eq!(times[1].0, -F);
        assert_eq!(times[2].0, 0);
        assert_eq!(times[3].0, F);
    }

    #[test]
    fn three_b_frames_work_the_same_way() {
        let order = decode_order(40, 3);
        let times = run(3, &order);
        let mut last = i64::MIN;
        for (dts, pts) in &times {
            assert!(*dts > last && dts <= pts);
            last = *dts;
        }
        assert_eq!(times[0].0, -3 * F);
    }

    #[test]
    fn a_run_of_skipped_slots_carries_through_and_stays_ordered() {
        // Slots 0 1 2 then a gap of 40 frames (a stall), then 43 44 45...
        let slots: Vec<i64> = [0, 1, 2, 3, 43, 44, 45, 46, 47, 48].to_vec();
        let mut clock = DtsClock::new(2, F);
        for s in &slots {
            clock.picture_in(s * F);
        }
        // Decode order for 10 pictures with 2 B-frames: indexes 0 3 1 2 6 4 5 9 7 8.
        let order = [0usize, 3, 1, 2, 6, 4, 5, 9, 7, 8];
        let mut last = i64::MIN;
        for &i in &order {
            let dts = clock.picture_out().unwrap();
            let pts = slots[i] * F;
            assert!(dts > last, "{dts} after {last}");
            assert!(dts <= pts, "dts {dts} pts {pts}");
            last = dts;
        }
    }

    #[test]
    fn a_stream_that_ends_early_still_gets_times_for_what_came_out() {
        // Two pictures in, two out, with a delay of 2: both are before the first PTS.
        let mut clock = DtsClock::new(2, F);
        clock.picture_in(0);
        clock.picture_in(F);
        assert_eq!(clock.picture_out(), Some(-2 * F));
        assert_eq!(clock.picture_out(), Some(-F));
        assert_eq!(clock.picture_out(), None);
    }

    #[test]
    fn nothing_in_means_no_time() {
        assert_eq!(DtsClock::new(0, F).picture_out(), None);
        assert_eq!(DtsClock::new(2, F).picture_out(), None);
    }
}
