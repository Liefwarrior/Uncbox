//! One stream, start to finish: capture, convert, encode, mux, send.
//!
//! Threads, and why there are several:
//! - **capture** wakes on the frame clock, takes the newest screen, converts it on the card and
//!   hands the picture to the encoder. It never waits on anything slow.
//! - **encoder** feeds the card's encoder and collects what comes out as FLV packets.
//! - **sound** reads the Uncbox app's pipe (or makes silence), keeps it on the same clock, and encodes it.
//! - **network** is the only thread that writes to the server, from a line that thins out video
//!   when the connection can't keep up (see `queue.rs`).
//! - the **main** thread listens for `q`, prints the once-a-second report and ends everything.
//!
//! One clock rules: `Instant` (Windows' high-resolution performance counter). Picture n is stamped
//! n / fps seconds after the start; sound is stamped by how many samples have gone out. If the
//! machine can't make a picture in time its slot is skipped, never stretched, so sound and picture
//! never drift apart.

use crate::audio::{self, AudioParams, AudioStats};
use crate::capture::{Capturer, Grab};
use crate::convert::Converter;
use crate::error::{Context, Error, Result};
use crate::flv::{self, AvcPacket, Metadata};
use crate::gpu::{self, Gpu};
use crate::h264;
use crate::log::{debug, warn};
use crate::mf::{self, EncodedVideo, HardwareEncoder, VideoConfig, VideoEncoder};
use crate::net;
use crate::progress::{Progress, RateWindow};
use crate::queue::{Packet, PacketQueue, Taken};
use crate::rtmp::{Publisher, RtmpUrl};
use crate::settings::{target_size, EncoderChoice, Settings};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::MediaFoundation::IMFSample;
use windows::Win32::System::Threading::{
    CreateWaitableTimerExW, GetCurrentProcess, SetPriorityClass, SetWaitableTimer, WaitForSingleObject, ABOVE_NORMAL_PRIORITY_CLASS,
    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS,
};

/// What the main thread is told by whoever listens on stdin.
pub enum Control {
    Stop,
}

/// How long the whole stream gets to shut down after a stop.
const SHUTDOWN_BUDGET: Duration = Duration::from_millis(1400);
/// Converted pictures that rotate between the converter and the encoder.
const PICTURE_POOL: usize = 12;

/// State all the threads read or add to.
#[derive(Default)]
struct Shared {
    /// Set when the stream should end (asked to, or because something failed); shared with the sound thread.
    stop: Arc<AtomicBool>,
    fatal: Mutex<Option<String>>,
    /// Video packets handed to the server.
    frames_sent: AtomicU64,
    bytes_sent: AtomicU64,
    /// Time of the newest video packet sent, in milliseconds of stream time.
    last_video_ms: AtomicI64,
    /// Slots skipped because the capture couldn't keep up, and pictures the encoder had no room for.
    skipped: AtomicU64,
    /// Pictures that repeated the last one because the screen hadn't changed.
    repeated: AtomicU64,
}

impl Shared {
    fn fail(&self, message: String) {
        debug(&format!("stopping because of a problem in the {} thread: {message}", std::thread::current().name().unwrap_or("?")));
        let mut slot = self.fatal.lock().expect("fatal lock");
        if slot.is_none() {
            *slot = Some(message);
        }
        self.stop.store(true, Ordering::SeqCst);
    }

    fn fatal(&self) -> Option<String> {
        self.fatal.lock().expect("fatal lock").clone()
    }
}

/// Which encoder runs the picture for this screen, or why none can.
pub fn choose_encoder(choice: EncoderChoice, adapter: &gpu::AdapterInfo) -> Result<HardwareEncoder> {
    let vendor = gpu::vendor_name(adapter.vendor_id);
    if choice != EncoderChoice::Auto && choice.name() != vendor {
        return Err(Error::new(format!(
            "You asked for the {} encoder, but this screen is on {} graphics ({}). Use Automatic.",
            choice.name(),
            vendor,
            adapter.name
        )));
    }
    mf::hardware_h264_encoders(adapter.luid).into_iter().next().ok_or_else(|| {
        Error::new(format!("{} has no video encoder Uncbox can use. It needs a recent NVIDIA, AMD or Intel graphics card with current drivers.", adapter.name))
    })
}

/// A high-resolution timer to sleep until exact moments on the frame clock.
struct Ticker {
    handle: HANDLE,
}

impl Ticker {
    fn new() -> Ticker {
        // SAFETY: plain timer creation; a failure leaves a null handle and falls back to sleeping.
        let handle = unsafe { CreateWaitableTimerExW(None, None, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0) }.unwrap_or_default();
        Ticker { handle }
    }

    fn sleep_until(&self, moment: Instant) {
        let left = moment.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        if self.handle.is_invalid() {
            std::thread::sleep(left);
            return;
        }
        // Negative means "from now", in 100 ns steps.
        let due = -((left.as_nanos() / 100) as i64).max(1);
        // SAFETY: the handle is a live timer and `due` outlives the call.
        unsafe {
            if SetWaitableTimer(self.handle, &due, 0, None, None, false).is_ok() {
                WaitForSingleObject(self.handle, 1000);
            } else {
                std::thread::sleep(left);
            }
        }
    }
}

impl Drop for Ticker {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            // SAFETY: closing the handle this struct created.
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

/// Turns the encoder's pictures into FLV packets for the line to the network.
struct VideoMux {
    queue: Arc<PacketQueue>,
    bframes: u32,
    frame_ticks: i64,
    header_sent: bool,
    decode_index: i64,
    /// Added to every time stamp so none is negative; the sound is delayed by the same.
    shift: i64,
    last_dts_ms: i64,
    skipped_before_header: u64,
}

impl VideoMux {
    fn new(queue: Arc<PacketQueue>, bframes: u32, fps: u32) -> Self {
        VideoMux {
            queue,
            bframes,
            frame_ticks: 10_000_000 / i64::from(fps),
            header_sent: false,
            decode_index: 0,
            shift: 0,
            last_dts_ms: -1,
            skipped_before_header: 0,
        }
    }

    fn push(&mut self, enc: EncodedVideo) {
        let pic = h264::annexb_to_avcc(&enc.data);
        if pic.avcc.is_empty() {
            return;
        }
        if !self.header_sent {
            // Nothing can be played before the first keyframe and its parameter sets.
            let (Some(sps), Some(pps), true) = (&pic.sps, &pic.pps, pic.keyframe) else {
                self.skipped_before_header += 1;
                return;
            };
            // Without the encoder's own decode times, they are worked out from the order of pictures.
            self.shift = match enc.dts {
                Some(first) if first < 0 => -first,
                Some(_) => 0,
                None if self.bframes > 0 => i64::from(self.bframes + 1) * self.frame_ticks,
                None => 0,
            };
            let body = flv::video_body(true, AvcPacket::SequenceHeader, 0, &h264::decoder_config(sps, pps));
            self.queue.push(Packet::VideoHeader { body, audio_shift_ms: self.shift / 10_000 });
            self.header_sent = true;
        }
        let dts = match enc.dts {
            Some(d) => d,
            None if self.bframes > 0 => self.decode_index * self.frame_ticks,
            None => enc.pts,
        };
        self.decode_index += 1;
        let dts_ms = ((dts + self.shift) / 10_000).max(self.last_dts_ms);
        self.last_dts_ms = dts_ms;
        let cts_ms = (((enc.pts + self.shift) / 10_000) - dts_ms).max(0) as i32;
        let keyframe = pic.keyframe;
        self.queue.push(Packet::Video { dts_ms, body: flv::video_body(keyframe, AvcPacket::Nalu, cts_ms, &pic.avcc), keyframe, reference: pic.reference });
    }
}

/// Lets a graphics object move to the thread that will use it. Direct3D and Media Foundation
/// objects can be used from any thread (that is what the multithread protection on the device is
/// for); Rust just can't know that, so each is handed over whole and used by one thread at a time.
struct Moved<T>(T);

// SAFETY: see above; every `Moved` value is used by exactly one thread after it is handed over.
unsafe impl<T> Send for Moved<T> {}

impl<T> Moved<T> {
    fn into_inner(self) -> T {
        self.0
    }
}

type Picture = (Moved<IMFSample>, u64);

/// Everything `run` sets up before the first picture.
struct Parts {
    capturer: Capturer,
    converter: Converter,
    encoder: VideoEncoder,
    out: (u32, u32),
    encoder_name: String,
}

fn prepare(settings: &Settings) -> Result<Parts> {
    let adapters = gpu::enumerate()?;
    let (adapter, output) = gpu::find_output(&adapters, settings.screen)?;
    debug(&format!("screen {} is output {} of {} ({})", settings.screen, output.on_adapter, adapter.name, gpu::vendor_name(adapter.vendor_id)));
    let hardware = choose_encoder(settings.encoder, adapter)?;
    let dxgi_adapter = gpu::open_adapter(adapter.index)?;
    let gpu = Gpu::open(&dxgi_adapter)?;
    let dxgi_output = gpu::open_output(&dxgi_adapter, output.on_adapter)?;
    let capturer = Capturer::new(&gpu, &dxgi_output)?;
    let out = target_size(capturer.width, capturer.height, settings.height);
    debug(&format!("capturing {}x{}, sending {}x{}", capturer.width, capturer.height, out.0, out.1));
    let converter = Converter::new(&gpu, capturer.width, capturer.height, out.0, out.1, settings.fps, PICTURE_POOL)?;
    let config = VideoConfig {
        width: out.0,
        height: out.1,
        fps: settings.fps,
        kbps: settings.kbps,
        gop: settings.gop(),
        bframes: settings.bframes,
        quality: settings.quality,
    };
    let encoder = VideoEncoder::new(&gpu, &hardware, &config).or_else(|first| {
        // Some encoders refuse the B-frame setting outright: try again without.
        if settings.bframes > 0 {
            VideoEncoder::new(&gpu, &hardware, &VideoConfig { bframes: 0, ..config.clone() })
        } else {
            Err(first)
        }
    })?;
    debug(&format!("encoder {} (async: {}, b-frames: {})", encoder.name, encoder.is_async, encoder.bframes));
    let encoder_name = encoder.name.clone();
    Ok(Parts { capturer, converter, encoder, out, encoder_name })
}

/// Streams until told to stop (or something goes wrong). Prints the report on stdout.
pub fn run(settings: Settings, control: Receiver<Control>) -> Result<()> {
    // Above normal, so a game using the whole machine doesn't make the stream stutter.
    // SAFETY: plain calls on this process.
    unsafe {
        let _ = SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
    }
    mf::startup()?;
    let url = RtmpUrl::parse(&settings.url)?;
    let parts = prepare(&settings)?;
    let Parts { mut capturer, converter, encoder, out, encoder_name } = parts;

    // Connect before capturing anything, so a refused key fails fast and cheaply.
    let connection = net::connect(&url)?;
    // The handshake wants some bytes that differ from one connection to the next, not secret ones.
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) ^ u64::from(std::process::id());
    let mut publisher = Publisher::open(connection, &url, 0, seed)?;
    publisher.send_metadata(&flv::metadata_payload(&Metadata {
        width: out.0,
        height: out.1,
        fps: settings.fps,
        video_kbps: settings.kbps,
        audio_kbps: settings.audio_kbps,
        encoder: format!("Uncbox ({encoder_name})"),
    }))?;

    // Wait (briefly) for the first picture of the screen: a still screen may not send one at once,
    // and the clock must not start before there is something to put on it.
    capturer.wait_for_picture(Duration::from_secs(2)).context("Couldn't capture the screen")?;

    // The app's pipe is opened last: its writer starts its real-time clock on connection.
    let pipe = match &settings.audio_pipe {
        Some(name) => Some(audio::open_pipe(name)?),
        None => None,
    };
    let start = Instant::now();

    let shared = Arc::new(Shared::default());
    let queue = Arc::new(PacketQueue::new());
    let audio_stats = Arc::new(AudioStats::default());
    let mut handles: Vec<JoinHandle<()>> = Vec::new();
    let (tx, rx) = sync_channel::<Picture>(4);

    // -- network --
    let net_handle = {
        let (shared, queue) = (shared.clone(), queue.clone());
        spawn("network", shared.clone(), move || network_thread(publisher, queue, shared))
    };

    // -- sound --
    {
        let (shared, queue, stats) = (shared.clone(), queue.clone(), audio_stats.clone());
        let params = AudioParams { pipe, kbps: settings.audio_kbps, start, stop: shared.stop.clone() };
        handles.push(spawn("sound", shared.clone(), move || {
            if let Err(e) = audio::run(params, queue, stats, warn) {
                shared.fail(e.to_string());
            }
        }));
    }

    // -- encoder --
    {
        let (shared, queue) = (shared.clone(), queue.clone());
        let fps = settings.fps;
        let encoder = Moved(encoder);
        handles.push(spawn("encoder", shared.clone(), move || {
            if let Err(e) = encoder_thread(encoder.into_inner(), rx, queue, fps, shared.clone()) {
                shared.fail(e.to_string());
            }
        }));
    }

    // -- capture --
    {
        let shared = shared.clone();
        let fps = settings.fps;
        let graphics = Moved((capturer, converter));
        handles.push(spawn("capture", shared.clone(), move || {
            let (capturer, converter) = graphics.into_inner();
            if let Err(e) = capture_thread(capturer, converter, tx, fps, start, shared.clone()) {
                shared.fail(e.to_string());
            }
        }));
    }

    report_loop(&shared, &queue, &control, start);

    // Stop: capture ends first (it drops the channel, which ends the encoder), then the line is closed.
    let stop_at = Instant::now();
    shared.stop.store(true, Ordering::SeqCst);
    for h in handles {
        let _ = h.join();
    }
    queue.close();
    let _ = net_handle.join();
    debug(&format!(
        "shut down in {} ms; sound: {} blocks of silence put in, {} dropped",
        stop_at.elapsed().as_millis(),
        audio_stats.filled_blocks.load(Ordering::Relaxed),
        audio_stats.dropped_blocks.load(Ordering::Relaxed)
    ));

    let progress = snapshot(&shared, &queue, start, 0.0, 0.0);
    print_block(&progress, true);
    match shared.fatal() {
        Some(message) => Err(Error::new(message)),
        None => Ok(()),
    }
}

/// Runs `body` on a named thread; a panic becomes a fatal error instead of a silent hang.
fn spawn(name: &str, shared: Arc<Shared>, body: impl FnOnce() + Send + 'static) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            mf::init_thread();
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).is_err() {
                shared.fail("Uncbox's streaming engine hit an unexpected problem.".to_string());
            }
        })
        .expect("spawn thread")
}

fn snapshot(shared: &Shared, queue: &PacketQueue, start: Instant, fps: f64, kbps: f64) -> Progress {
    let out_ms = shared.last_video_ms.load(Ordering::Relaxed).max(0);
    let wall = start.elapsed().as_secs_f64();
    Progress {
        frames: shared.frames_sent.load(Ordering::Relaxed),
        fps,
        bitrate_kbps: kbps,
        total_size: shared.bytes_sent.load(Ordering::Relaxed),
        out_time_us: out_ms * 1000,
        dup_frames: shared.repeated.load(Ordering::Relaxed),
        drop_frames: shared.skipped.load(Ordering::Relaxed) + queue.dropped.load(Ordering::Relaxed),
        speed: if wall > 0.5 { (out_ms as f64 / 1000.0) / wall } else { 0.0 },
    }
}

fn print_block(progress: &Progress, last: bool) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(progress.block(last).as_bytes());
    let _ = out.flush();
}

fn report_loop(shared: &Shared, queue: &PacketQueue, control: &Receiver<Control>, start: Instant) {
    let mut rate = RateWindow::new(4);
    let mut previous = (Instant::now(), 0u64);
    let mut next_report = Instant::now() + Duration::from_secs(1);
    loop {
        match control.recv_timeout(Duration::from_millis(50)) {
            Ok(Control::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if shared.stop.load(Ordering::Relaxed) {
            return;
        }
        if Instant::now() < next_report {
            continue;
        }
        next_report += Duration::from_secs(1);
        let frames = shared.frames_sent.load(Ordering::Relaxed);
        let dt = previous.0.elapsed().as_secs_f64().max(0.001);
        let fps = (frames - previous.1) as f64 / dt;
        previous = (Instant::now(), frames);
        let kbps = rate.push(start.elapsed().as_micros() as i64, shared.bytes_sent.load(Ordering::Relaxed));
        // Nothing to report until the first picture has really gone out.
        if frames > 0 {
            print_block(&snapshot(shared, queue, start, fps, kbps), false);
        }
    }
}

fn capture_thread(
    mut capturer: Capturer,
    mut converter: Converter,
    tx: std::sync::mpsc::SyncSender<Picture>,
    fps: u32,
    start: Instant,
    shared: Arc<Shared>,
) -> Result<()> {
    let ticker = Ticker::new();
    let slot = |n: u64| start + Duration::from_nanos(n * 1_000_000_000 / u64::from(fps));
    let frame_ticks = 10_000_000 / i64::from(fps);
    let mut n: u64 = 0;
    while !shared.stop.load(Ordering::Relaxed) {
        ticker.sleep_until(slot(n));
        if shared.stop.load(Ordering::Relaxed) {
            break;
        }
        // Behind by whole frames: skip those slots (and count them) rather than stretch the stream.
        let late = Instant::now().saturating_duration_since(slot(n)).as_nanos() as u64 * u64::from(fps) / 1_000_000_000;
        if late >= 1 {
            shared.skipped.fetch_add(late, Ordering::Relaxed);
            n += late;
        }
        match capturer.grab().context("Couldn't capture the screen")? {
            Grab::New => {}
            Grab::Same => {
                shared.repeated.fetch_add(1, Ordering::Relaxed);
            }
        }
        let screen = capturer.picture().clone();
        let picture = converter.convert(&screen)?;
        let sample = VideoEncoder::sample_for(&picture, (n * 10_000_000 / u64::from(fps)) as i64, frame_ticks)
            .context("Couldn't hand a picture to the video encoder")?;
        match tx.try_send((Moved(sample), n)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                shared.skipped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => break,
        }
        n += 1;
    }
    if capturer.restarts > 0 {
        debug(&format!("the screen capture restarted {} time(s)", capturer.restarts));
    }
    Ok(())
}

fn encoder_thread(mut encoder: VideoEncoder, rx: Receiver<Picture>, queue: Arc<PacketQueue>, fps: u32, shared: Arc<Shared>) -> Result<()> {
    let mut mux = VideoMux::new(queue.clone(), encoder.bframes, fps);
    let mut out: Vec<EncodedVideo> = Vec::new();
    let mut pending: Option<IMFSample> = None;
    let mut disconnected = false;
    loop {
        encoder.poll(&mut out)?;
        if queue.want_keyframe.swap(false, Ordering::Relaxed) {
            encoder.force_keyframe();
        }
        if pending.is_none() && !disconnected {
            match rx.recv_timeout(Duration::from_millis(2)) {
                Ok((sample, _)) => pending = Some(sample.into_inner()),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => disconnected = true,
            }
        } else if pending.is_some() && !encoder.wants_input() {
            std::thread::sleep(Duration::from_millis(1));
        }
        if let Some(sample) = &pending {
            if encoder.wants_input() {
                encoder.feed(sample, &mut out)?;
                pending = None;
            }
        }
        for enc in out.drain(..) {
            mux.push(enc);
        }
        if disconnected && pending.is_none() {
            break;
        }
        if shared.fatal().is_some() {
            return Ok(());
        }
    }
    encoder.drain(&mut out, Duration::from_millis(500));
    for enc in out.drain(..) {
        mux.push(enc);
    }
    Ok(())
}

fn network_thread(mut publisher: Publisher<net::Connection>, queue: Arc<PacketQueue>, shared: Arc<Shared>) {
    let mut audio_shift = 0i64;
    let mut header_seen = false;
    let mut stashed: Vec<Packet> = Vec::new();
    let mut next_poll = Instant::now() + Duration::from_millis(250);
    let mut stop_deadline: Option<Instant> = None;

    let send = |publisher: &mut Publisher<net::Connection>, packet: Packet, shift: i64| -> Result<()> {
        match packet {
            Packet::VideoHeader { body, .. } => publisher.send_video(0, &body)?,
            Packet::Video { dts_ms, body, .. } => {
                publisher.send_video(dts_ms as u32, &body)?;
                shared.frames_sent.fetch_add(1, Ordering::Relaxed);
                shared.last_video_ms.store(dts_ms, Ordering::Relaxed);
            }
            Packet::Audio { ts_ms, body } => {
                let is_config = body.get(1) == Some(&0);
                publisher.send_audio(if is_config { 0 } else { (ts_ms + shift) as u32 }, &body)?;
            }
        }
        shared.bytes_sent.store(publisher.bytes_sent(), Ordering::Relaxed);
        Ok(())
    };

    let result = (|| -> Result<()> {
        loop {
            if shared.stop.load(Ordering::Relaxed) && stop_deadline.is_none() {
                stop_deadline = Some(Instant::now() + SHUTDOWN_BUDGET);
            }
            if stop_deadline.is_some_and(|d| Instant::now() > d) {
                return Ok(());
            }
            match queue.take(Duration::from_millis(20)) {
                Taken::Packet(packet) => match packet {
                    Packet::VideoHeader { audio_shift_ms, .. } => {
                        audio_shift = audio_shift_ms;
                        header_seen = true;
                        send(&mut publisher, packet, 0)?;
                        for held in stashed.drain(..) {
                            send(&mut publisher, held, audio_shift)?;
                        }
                    }
                    Packet::Audio { ref body, .. } if body.get(1) != Some(&0) && !header_seen => {
                        stashed.push(packet);
                        if stashed.len() > 300 {
                            // No video is coming: send the sound on its own rather than hold it forever.
                            header_seen = true;
                            for held in stashed.drain(..) {
                                send(&mut publisher, held, 0)?;
                            }
                        }
                    }
                    other => send(&mut publisher, other, audio_shift)?,
                },
                Taken::Empty => {}
                Taken::Done => return Ok(()),
            }
            if Instant::now() >= next_poll {
                next_poll = Instant::now() + Duration::from_millis(250);
                publisher.poll(Duration::from_millis(1))?;
            }
        }
    })();
    if let Err(e) = result {
        shared.fail(e.to_string());
    }
    publisher.close();
}

// ---- probing ----

/// What `probe` reports.
pub fn probe_json() -> serde_json::Value {
    let _ = mf::startup();
    let adapters = gpu::enumerate().unwrap_or_default();
    let mut encoders: Vec<&'static str> = Vec::new();
    let mut listed = Vec::new();
    for adapter in &adapters {
        let vendor = gpu::vendor_name(adapter.vendor_id);
        listed.push(serde_json::json!({
            "name": adapter.name,
            "vendor": vendor,
            "outputs": adapter.outputs.iter().map(|o| serde_json::json!({
                "index": o.index, "width": o.width, "height": o.height, "primary": o.primary,
            })).collect::<Vec<_>>(),
        }));
        if vendor != "other" && !adapter.outputs.is_empty() && !encoders.contains(&vendor) && encoder_starts(adapter) {
            encoders.push(vendor);
        }
    }
    serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "adapters": listed, "encoders": encoders })
}

/// Whether the adapter's hardware encoder really starts (an installed driver can still refuse).
fn encoder_starts(adapter: &gpu::AdapterInfo) -> bool {
    let list = mf::hardware_h264_encoders(adapter.luid);
    let Some(hardware) = list.first() else { return false };
    let Ok(dxgi) = gpu::open_adapter(adapter.index) else { return false };
    let Ok(gpu) = Gpu::open(&dxgi) else { return false };
    let config = VideoConfig { width: 1280, height: 720, fps: 30, kbps: 2500, gop: 60, bframes: 0, quality: 70 };
    VideoEncoder::new(&gpu, hardware, &config).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: &[u8] = &[0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9, 0x40, 0x78, 0x02, 0x27];
    const PPS: &[u8] = &[0x68, 0xEB, 0xE3, 0xCB];
    const FRAME: i64 = 166_667;

    fn annexb(nals: &[&[u8]]) -> Vec<u8> {
        nals.iter().flat_map(|n| [&[0u8, 0, 0, 1][..], n].concat()).collect()
    }

    fn key(pts: i64, dts: Option<i64>) -> EncodedVideo {
        EncodedVideo { data: annexb(&[SPS, PPS, &[0x65, 1, 2, 3]]), pts, dts, clean_point: true }
    }

    fn inter(pts: i64, dts: Option<i64>, ref_idc: u8) -> EncodedVideo {
        EncodedVideo { data: annexb(&[&[(ref_idc << 5) | 1, 9, 9]]), pts, dts, clean_point: false }
    }

    fn drain(queue: &PacketQueue) -> Vec<Packet> {
        let mut out = Vec::new();
        while let Taken::Packet(p) = queue.take(Duration::ZERO) {
            out.push(p);
        }
        out
    }

    /// The decode time and composition time (in ms) of each picture the line holds.
    fn times(packets: &[Packet]) -> Vec<(i64, i32)> {
        packets
            .iter()
            .filter_map(|p| match p {
                Packet::Video { dts_ms, body, .. } => Some((*dts_ms, i32::from_be_bytes([0, body[2], body[3], body[4]]))),
                _ => None,
            })
            .collect()
    }

    fn shift_of(packets: &[Packet]) -> i64 {
        match &packets[0] {
            Packet::VideoHeader { audio_shift_ms, .. } => *audio_shift_ms,
            other => panic!("expected the header first, got {other:?}"),
        }
    }

    #[test]
    fn nothing_goes_out_before_the_first_keyframe_with_its_parameter_sets() {
        let queue = Arc::new(PacketQueue::new());
        let mut mux = VideoMux::new(queue.clone(), 0, 60);
        mux.push(inter(0, None, 2));
        assert!(drain(&queue).is_empty());
        mux.push(key(FRAME, None));
        let got = drain(&queue);
        assert!(matches!(got[0], Packet::VideoHeader { audio_shift_ms: 0, .. }));
        assert!(matches!(got[1], Packet::Video { keyframe: true, .. }));
    }

    #[test]
    fn the_header_is_the_decoder_config_in_an_avc_sequence_header_tag() {
        let queue = Arc::new(PacketQueue::new());
        VideoMux::new(queue.clone(), 0, 30).push(key(0, None));
        let Packet::VideoHeader { body, .. } = &drain(&queue)[0] else { panic!("no header") };
        assert_eq!(&body[..5], &[0x17, 0, 0, 0, 0]);
        assert_eq!(&body[5..11], &[1, 0x64, 0x00, 0x28, 0xFF, 0xE1]);
    }

    #[test]
    fn without_b_frames_the_time_stamp_is_the_capture_time_and_nothing_is_added() {
        let queue = Arc::new(PacketQueue::new());
        let mut mux = VideoMux::new(queue.clone(), 0, 60);
        mux.push(key(0, None));
        mux.push(inter(FRAME, None, 2));
        mux.push(inter(2 * FRAME, None, 2));
        assert_eq!(times(&drain(&queue)), vec![(0, 0), (16, 0), (33, 0)]);
    }

    #[test]
    fn with_b_frames_and_no_decode_times_everything_is_delayed_enough_for_none_to_be_negative() {
        let queue = Arc::new(PacketQueue::new());
        let mut mux = VideoMux::new(queue.clone(), 2, 60);
        // Decode order I0 P3 B1 B2: shown in the order 0 1 2 3.
        mux.push(key(0, None));
        mux.push(inter(3 * FRAME, None, 2));
        mux.push(inter(FRAME, None, 0));
        mux.push(inter(2 * FRAME, None, 0));
        let got = drain(&queue);
        assert_eq!(shift_of(&got), 49, "three frames at 60 fps, so the sound is delayed with the picture");
        let mut last = -1;
        for (dts, cts) in times(&got) {
            assert!(dts > last, "decode times only go up");
            assert!(cts >= 0, "no picture is shown before it is decoded");
            last = dts;
        }
    }

    #[test]
    fn the_encoders_own_decode_times_are_used_and_a_negative_start_is_shifted_away() {
        let queue = Arc::new(PacketQueue::new());
        let mut mux = VideoMux::new(queue.clone(), 2, 60);
        mux.push(key(0, Some(-2 * FRAME)));
        mux.push(inter(3 * FRAME, Some(-FRAME), 2));
        let got = drain(&queue);
        assert_eq!(shift_of(&got), 33);
        // The first picture is decoded at 0 and shown 33 ms later; the second is decoded 16 ms after and shown about 67 ms after it is decoded.
        assert_eq!(times(&got), vec![(0, 33), (16, 67)]);
    }

    #[test]
    fn marks_pictures_nothing_depends_on() {
        let queue = Arc::new(PacketQueue::new());
        let mut mux = VideoMux::new(queue.clone(), 0, 60);
        mux.push(key(0, None));
        mux.push(inter(FRAME, None, 0));
        let got = drain(&queue);
        assert!(matches!(got[2], Packet::Video { keyframe: false, reference: false, .. }));
    }

    #[test]
    fn picks_an_encoder_by_name_only_when_the_screen_is_on_that_makers_card() {
        let adapter =
            gpu::AdapterInfo { index: 0, name: "Test GPU".into(), vendor_id: 0x10DE, luid: windows::Win32::Foundation::LUID::default(), outputs: vec![] };
        let err = choose_encoder(EncoderChoice::Amd, &adapter).err().expect("should refuse");
        assert!(err.message().contains("amd") && err.message().contains("nvidia"), "{err}");
    }
}
