//! One stream, start to finish: capture, convert, encode, mux, send.
//!
//! Threads, and why there are several:
//! - **capture** wakes on the frame clock, takes the newest picture (the screen, or the next picture
//!   of a video file), converts it on the card and hands it to the encoder. For the screen it never
//!   waits on anything slow.
//! - **encoder** feeds the card's encoder and collects what comes out as FLV packets.
//! - **sound** reads the Uncbox app's pipe (or makes silence), keeps it on the same clock, and encodes it.
//! - **network** is the only thread that writes to the server (or the file), from a line that thins
//!   out video when the connection can't keep up (see `queue.rs`).
//! - the **main** thread listens for `q`, prints the once-a-second report and ends everything.
//!
//! One clock rules: `Instant` (Windows' high-resolution performance counter). Picture n is stamped
//! n / fps seconds after the start; sound is stamped by how many samples have gone out. If the
//! machine can't make a picture in time its slot is skipped, never stretched, so sound and picture
//! never drift apart. (A video file is the exception to skipping: its pictures are all sent.)

use crate::audio::{self, AudioParams, AudioStats};
use crate::capture::Capturer;
use crate::convert::{Converter, Picture};
use crate::encoder::{self, Encoder};
use crate::error::{Context, Error, Result};
use crate::flv::{self, AvcPacket, Metadata};
use crate::gpu::{self, AdapterInfo, Gpu};
use crate::h264;
use crate::log::{debug, warn};
use crate::mf::{self, EncodedVideo};
use crate::net;
use crate::probe::{self, EncoderCheck, ProbeAdapter, ProbeOutput};
use crate::progress::{Progress, RateWindow};
use crate::queue::{AudioHold, Packet, PacketQueue, Taken};
use crate::rtmp::{Publisher, RtmpUrl};
use crate::settings::{target_size, EncoderChoice, Output, Settings, Source as SourceSetting};
use crate::sink::{FileSink, Sink};
use crate::source::{Source, Y4mSource};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
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

/// State all the threads read or add to.
#[derive(Default)]
struct Shared {
    /// Set when the stream should end now (asked to, or because something failed).
    stop: Arc<AtomicBool>,
    /// Set to end the sound: with `stop`, or alone when a video file has been played to its end.
    audio_stop: Arc<AtomicBool>,
    /// Set by the encoder thread when it has taken every picture there will be and sent all it made.
    input_done: AtomicBool,
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
        self.audio_stop.store(true, Ordering::SeqCst);
    }

    fn fatal(&self) -> Option<String> {
        self.fatal.lock().expect("fatal lock").clone()
    }
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

/// A converted picture on its way to the encoder, with the time it is shown.
struct Frame {
    picture: Moved<Picture>,
    pts: i64,
}

/// Everything `run` sets up before the first picture.
struct Parts {
    source: Source,
    converter: Converter,
    encoder: Encoder,
    out: (u32, u32),
}

/// The card a video file is encoded on: the one asked for by name, else the one the screen is on, else the first.
fn adapter_for_file<'a>(adapters: &'a [AdapterInfo], settings: &Settings) -> Result<&'a AdapterInfo> {
    let usable = |a: &&AdapterInfo| gpu::vendor_name(a.vendor_id) != "other";
    if settings.encoder != EncoderChoice::Auto {
        return adapters
            .iter()
            .find(|a| gpu::vendor_name(a.vendor_id) == settings.encoder.name())
            .ok_or_else(|| Error::new(format!("This PC has no {} graphics card.", settings.encoder.name())));
    }
    if let Ok((adapter, _)) = gpu::find_output(adapters, settings.screen) {
        return Ok(adapter);
    }
    adapters.iter().find(usable).ok_or_else(|| Error::new("Windows shows no graphics card to encode on."))
}

fn prepare(settings: &mut Settings) -> Result<Parts> {
    let adapters = gpu::enumerate()?;
    let (adapter, gpu, source) = match settings.source.clone() {
        SourceSetting::Screen => {
            let (adapter, output) = gpu::find_output(&adapters, settings.screen)?;
            debug(&format!("screen {} is output {} of {} ({})", settings.screen, output.on_adapter, adapter.name, gpu::vendor_name(adapter.vendor_id)));
            let dxgi_adapter = gpu::open_adapter(adapter.index)?;
            let gpu = Gpu::open(&dxgi_adapter)?;
            let mut capturer = Capturer::new(&gpu, &dxgi_adapter, output.on_adapter)?;
            // Wait (briefly) for the first picture of the screen: a still screen may not send one at
            // once, the clock must not start before there is something to put on it, and the shape of
            // the picture (a screen on its side) is only certain once one has come.
            capturer.wait_for_picture(Duration::from_secs(2)).context("Couldn't capture the screen")?;
            (adapter, gpu, Source::Screen(Box::new(capturer)))
        }
        SourceSetting::Y4m(path) => {
            let adapter = adapter_for_file(&adapters, settings)?;
            debug(&format!("encoding a video file on {} ({})", adapter.name, gpu::vendor_name(adapter.vendor_id)));
            let dxgi_adapter = gpu::open_adapter(adapter.index)?;
            let gpu = Gpu::open(&dxgi_adapter)?;
            let file = Y4mSource::open(&gpu, &path)?;
            // The file's own rate rules: its pictures are stamped at it.
            settings.fps = file.fps;
            (adapter, gpu, Source::Y4m(Box::new(file)))
        }
    };

    let geometry = source.geometry();
    let (upright_w, upright_h) = geometry.rotation.upright_size(geometry.width, geometry.height);
    let out = target_size(upright_w, upright_h, settings.height);
    debug(&format!("picture {}x{} turned {:?}, sending {}x{}", geometry.width, geometry.height, geometry.rotation, out.0, out.1));

    let mut encoder = Encoder::open(&gpu, adapter, settings, out)?;
    debug(&format!("encoder {} ({}, {} B-frames, tuning {:?})", encoder.label, encoder.backend, encoder.bframes, encoder.tuning));
    let mut converter = Converter::new(&gpu, out.0, out.1, settings.fps, encoder.pool)?;
    converter.set_source(geometry)?;
    if geometry.rotation != crate::orient::Rotation::None && !converter.can_rotate() {
        debug("This graphics card can't turn the picture upright, so the screen is sent sideways.");
    }
    encoder.set_releaser(converter.releaser());
    Ok(Parts { source, converter, encoder, out })
}

/// The lines added to every progress block: which encoder is running and how it is set.
fn encoder_lines(encoder: &Encoder, source: &Source) -> String {
    let mut text = format!("encoder_backend={}\nencoder_name={}\nencoder_bframes={}\n", encoder.backend, encoder.label, encoder.bframes);
    if let Some(tuning) = encoder.tuning {
        text.push_str(&format!("encoder_tuning={}\n", tuning.name()));
    }
    text.push_str(if source.is_live() { "source=screen\n" } else { "source=y4m\n" });
    text
}

/// Streams until told to stop (or something goes wrong, or a video file ends). Prints the report on stdout.
pub fn run(mut settings: Settings, control: Receiver<Control>) -> Result<()> {
    // Above normal, so a game using the whole machine doesn't make the stream stutter.
    // SAFETY: plain calls on this process.
    unsafe {
        let _ = SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
    }
    mf::startup()?;
    let rtmp_url = match &settings.output {
        Output::Rtmp(url) => Some(RtmpUrl::parse(url)?),
        Output::File(_) => None,
    };
    let Parts { source, converter, encoder, out } = prepare(&mut settings)?;
    let extra = encoder_lines(&encoder, &source);
    let live = source.is_live();
    // A video file played as fast as it will go has no clock, so no sound either.
    let paced = live || settings.pace;
    let has_sound = paced;
    let fps = settings.fps;

    // Connect before capturing a single picture, so a refused key fails fast and cheaply.
    let (mut sink, lossless): (Box<dyn Sink + Send>, bool) = match (&settings.output, &rtmp_url) {
        (Output::Rtmp(_), Some(url)) => {
            let connection = net::connect(url)?;
            // The handshake wants some bytes that differ from one connection to the next, not secret ones.
            let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) ^ u64::from(std::process::id());
            (Box::new(Publisher::open(connection, url, 0, seed)?), false)
        }
        (Output::File(path), _) => (Box::new(FileSink::create(path, has_sound)?), true),
        _ => return Err(Error::new("There is no stream address to send to.")),
    };
    sink.send_metadata(&flv::metadata_payload(&Metadata {
        width: out.0,
        height: out.1,
        fps,
        video_kbps: settings.kbps,
        audio_kbps: settings.audio_kbps,
        encoder: format!("Uncbox ({})", encoder.label),
    }))?;
    debug(&format!(
        "Streaming with {}{}.",
        encoder.label,
        match encoder.tuning {
            Some(t) => format!(" ({} settings, {} B-frames)", t.name(), encoder.bframes),
            None => format!(" ({} B-frames)", encoder.bframes),
        }
    ));

    // The app's pipe is opened last: its writer starts its real-time clock on connection.
    let pipe = match (&settings.audio_pipe, has_sound) {
        (Some(name), true) => Some(audio::open_pipe(name)?),
        _ => None,
    };
    let start = Instant::now();

    let shared = Arc::new(Shared::default());
    let queue = Arc::new(if lossless { PacketQueue::lossless() } else { PacketQueue::new() });
    let audio_stats = Arc::new(AudioStats::default());
    let mut handles: Vec<JoinHandle<()>> = Vec::new();
    let (tx, rx) = sync_channel::<Frame>(4);

    // -- network --
    let net_handle = {
        let (shared, queue) = (shared.clone(), queue.clone());
        spawn("network", shared.clone(), move || network_thread(sink, queue, shared))
    };

    // -- sound --
    let sound_handle = if has_sound {
        let (shared, queue, stats) = (shared.clone(), queue.clone(), audio_stats.clone());
        let params = AudioParams { pipe, kbps: settings.audio_kbps, start, stop: shared.audio_stop.clone() };
        Some(spawn("sound", shared.clone(), move || {
            if let Err(e) = audio::run(params, queue, stats, warn) {
                shared.fail(e.to_string());
            }
        }))
    } else {
        None
    };

    // -- encoder --
    {
        let (shared, queue) = (shared.clone(), queue.clone());
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
        let graphics = Moved((source, converter));
        handles.push(spawn("capture", shared.clone(), move || {
            let (source, converter) = graphics.into_inner();
            if let Err(e) = capture_thread(source, converter, tx, fps, start, paced, shared.clone()) {
                shared.fail(e.to_string());
            }
        }));
    }

    report_loop(&shared, &queue, &control, start, &extra);

    // A video file that played to its end finishes the usual way: everything it made is sent, with no
    // time limit. Anything else (a stop, a failure) has a budget.
    let stop_at = Instant::now();
    let finished_by_itself = shared.input_done.load(Ordering::SeqCst) && !shared.stop.load(Ordering::SeqCst);
    if !finished_by_itself {
        shared.stop.store(true, Ordering::SeqCst);
    }
    shared.audio_stop.store(true, Ordering::SeqCst);
    for h in handles {
        let _ = h.join();
    }
    if let Some(h) = sound_handle {
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

    let progress = snapshot(&shared, &queue, start, 0.0, 0.0, &extra);
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

fn snapshot(shared: &Shared, queue: &PacketQueue, start: Instant, fps: f64, kbps: f64, extra: &str) -> Progress {
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
        extra: extra.to_string(),
    }
}

fn print_block(progress: &Progress, last: bool) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(progress.block(last).as_bytes());
    let _ = out.flush();
}

fn report_loop(shared: &Shared, queue: &PacketQueue, control: &Receiver<Control>, start: Instant, extra: &str) {
    let mut rate = RateWindow::new(4);
    let mut previous = (Instant::now(), 0u64);
    let mut next_report = Instant::now() + Duration::from_secs(1);
    loop {
        match control.recv_timeout(Duration::from_millis(50)) {
            Ok(Control::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if shared.stop.load(Ordering::Relaxed) || shared.input_done.load(Ordering::Relaxed) {
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
            print_block(&snapshot(shared, queue, start, fps, kbps, extra), false);
        }
    }
}

fn capture_thread(
    mut source: Source,
    mut converter: Converter,
    tx: SyncSender<Frame>,
    fps: u32,
    start: Instant,
    paced: bool,
    shared: Arc<Shared>,
) -> Result<()> {
    let live = source.is_live();
    let ticker = Ticker::new();
    let slot = |n: u64| start + Duration::from_nanos(n * 1_000_000_000 / u64::from(fps));
    let mut n: u64 = 0;
    while !shared.stop.load(Ordering::Relaxed) {
        if paced {
            ticker.sleep_until(slot(n));
            if shared.stop.load(Ordering::Relaxed) {
                break;
            }
        }
        // The screen, behind by whole frames: skip those slots (and count them) rather than stretch the stream.
        // A video file is never skipped: every one of its pictures is sent.
        if live {
            let late = Instant::now().saturating_duration_since(slot(n)).as_nanos() as u64 * u64::from(fps) / 1_000_000_000;
            if late >= 1 {
                shared.skipped.fetch_add(late, Ordering::Relaxed);
                n += late;
            }
        }
        let Some(grabbed) = source.next_frame()? else {
            // The video file has played to its end.
            debug("the video file has ended");
            break;
        };
        if grabbed.same {
            shared.repeated.fetch_add(1, Ordering::Relaxed);
        }
        converter.set_source(grabbed.geometry)?;
        let picture = loop {
            match converter.convert(&grabbed.texture)? {
                Some(p) => break Some(p),
                // Every picture is with the encoder: the screen moves on, a file waits.
                None if live => break None,
                None => {
                    if shared.stop.load(Ordering::Relaxed) {
                        break None;
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        };
        let Some(picture) = picture else {
            if live {
                shared.skipped.fetch_add(1, Ordering::Relaxed);
                n += 1;
                continue;
            }
            break;
        };
        let frame = Frame { picture: Moved(picture), pts: (n * 10_000_000 / u64::from(fps)) as i64 };
        if live {
            match tx.try_send(frame) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    shared.skipped.fetch_add(1, Ordering::Relaxed);
                }
                Err(TrySendError::Disconnected(_)) => break,
            }
        } else if tx.send(frame).is_err() {
            break;
        }
        n += 1;
    }
    if source.restarts() > 0 {
        debug(&format!("the screen capture restarted {} time(s)", source.restarts()));
    }
    Ok(())
}

fn encoder_thread(mut encoder: Encoder, rx: Receiver<Frame>, queue: Arc<PacketQueue>, fps: u32, shared: Arc<Shared>) -> Result<()> {
    let mut mux = VideoMux::new(queue.clone(), encoder.bframes, fps);
    let frame_ticks = 10_000_000 / i64::from(fps);
    let mut out: Vec<EncodedVideo> = Vec::new();
    let mut pending: Option<Frame> = None;
    let mut disconnected = false;
    loop {
        encoder.poll(&mut out)?;
        if queue.want_keyframe.swap(false, Ordering::Relaxed) {
            encoder.force_keyframe();
        }
        if pending.is_none() && !disconnected {
            match rx.recv_timeout(Duration::from_millis(2)) {
                Ok(frame) => pending = Some(frame),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => disconnected = true,
            }
        } else if pending.is_some() && !encoder.wants_input() {
            std::thread::sleep(Duration::from_millis(1));
        }
        if pending.is_some() && encoder.wants_input() {
            if let Some(frame) = pending.take() {
                let picture = frame.picture.into_inner();
                encoder.feed(&picture, frame.pts, frame_ticks, &mut out)?;
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
    encoder.finish(&mut out)?;
    for enc in out.drain(..) {
        mux.push(enc);
    }
    shared.input_done.store(true, Ordering::SeqCst);
    Ok(())
}

/// Sends a piece of sound at its time stamp (never negative).
fn send_sound(sink: &mut dyn Sink, shared: &Shared, ts_ms: i64, body: &[u8]) -> Result<()> {
    sink.send_audio(ts_ms.max(0) as u32, body)?;
    shared.bytes_sent.store(sink.bytes_sent(), Ordering::Relaxed);
    Ok(())
}

fn network_thread(mut sink: Box<dyn Sink + Send>, queue: Arc<PacketQueue>, shared: Arc<Shared>) {
    let mut audio_shift = 0i64;
    let mut header_seen = false;
    let mut stashed: Vec<(i64, Vec<u8>)> = Vec::new();
    // Sound waits here for the picture to catch up (see AudioHold).
    let mut hold = AudioHold::new();
    let mut last_video_ms = -1i64;
    let mut next_poll = Instant::now() + Duration::from_millis(250);
    let mut stop_deadline: Option<Instant> = None;

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
                    Packet::VideoHeader { body, audio_shift_ms } => {
                        audio_shift = audio_shift_ms;
                        header_seen = true;
                        sink.send_video(0, &body)?;
                        for (ts_ms, body) in stashed.drain(..) {
                            hold.push(ts_ms + audio_shift, body, Instant::now());
                        }
                    }
                    Packet::Video { dts_ms, body, .. } => {
                        sink.send_video(dts_ms as u32, &body)?;
                        shared.frames_sent.fetch_add(1, Ordering::Relaxed);
                        shared.last_video_ms.store(dts_ms, Ordering::Relaxed);
                        last_video_ms = dts_ms;
                    }
                    Packet::Audio { ts_ms, body } => {
                        if body.get(1) == Some(&0) {
                            // The decoder's note about the sound goes out at once.
                            send_sound(sink.as_mut(), &shared, 0, &body)?;
                        } else if !header_seen {
                            stashed.push((ts_ms, body));
                            if stashed.len() > 300 {
                                // No video is coming: send the sound on its own rather than hold it forever.
                                header_seen = true;
                                for (ts_ms, body) in stashed.drain(..) {
                                    hold.push(ts_ms, body, Instant::now());
                                }
                            }
                        } else {
                            hold.push(ts_ms + audio_shift, body, Instant::now());
                        }
                    }
                },
                Taken::Empty => {}
                Taken::Done => {
                    // The end: whatever sound is still waiting goes out after the last picture.
                    for (ts_ms, body) in hold.flush() {
                        send_sound(sink.as_mut(), &shared, ts_ms, &body)?;
                    }
                    return Ok(());
                }
            }
            for (ts_ms, body) in hold.release(last_video_ms, Instant::now()) {
                send_sound(sink.as_mut(), &shared, ts_ms, &body)?;
            }
            shared.bytes_sent.store(sink.bytes_sent(), Ordering::Relaxed);
            if Instant::now() >= next_poll {
                next_poll = Instant::now() + Duration::from_millis(250);
                sink.poll(Duration::from_millis(1))?;
            }
        }
    })();
    if let Err(e) = result {
        shared.fail(e.to_string());
    }
    sink.close();
}

// ---- probing ----

/// What `probe` reports (the shape is in `probe.rs`).
pub fn probe_json() -> serde_json::Value {
    let _ = mf::startup();
    let adapters = gpu::enumerate().unwrap_or_default();
    let mut tested: Vec<&'static str> = Vec::new();
    let listed: Vec<ProbeAdapter> = adapters
        .iter()
        .map(|adapter| {
            let vendor = gpu::vendor_name(adapter.vendor_id);
            let mut check = None;
            // Only a card with a screen on it is tried, and one card of each maker is enough.
            if vendor != "other" && !adapter.outputs.is_empty() && !tested.contains(&vendor) {
                tested.push(vendor);
                check = check_encoder(adapter);
            }
            ProbeAdapter {
                name: adapter.name.clone(),
                vendor,
                outputs: adapter.outputs.iter().map(|o| ProbeOutput { index: o.index, width: o.width, height: o.height, primary: o.primary }).collect(),
                check,
            }
        })
        .collect();
    probe::to_json(env!("CARGO_PKG_VERSION"), &listed)
}

/// Whether the adapter's hardware encoder really encodes (an installed driver can still refuse), and
/// with which settings: a few dozen tiny pictures are put through it. NVIDIA cards are tried with
/// the direct encoder first.
fn check_encoder(adapter: &AdapterInfo) -> Option<EncoderCheck> {
    let dxgi = gpu::open_adapter(adapter.index).ok()?;
    let gpu = Gpu::open(&dxgi).ok()?;
    let defaults = Settings::default();
    if gpu::vendor_name(adapter.vendor_id) == "nvidia" {
        let attempts = crate::tuning::attempts(crate::settings::TuningChoice::Auto, defaults.bframes);
        if let Some((tuning, bframes)) = crate::nvenc::first_working(&gpu.device, defaults.kbps, defaults.fps, defaults.keyframe_seconds, &attempts) {
            return Some(EncoderCheck { backend: "nvenc", tuning: tuning.name(), bframes });
        }
    }
    let hardware = mf::hardware_h264_encoders(adapter.luid, gpu::vendor_name(adapter.vendor_id)).into_iter().next()?;
    let config = encoder::mf_config(&defaults, (320, 192), defaults.bframes);
    let bframes = encoder::mf_self_test(&gpu, &hardware, &config).ok()?;
    Some(EncoderCheck { backend: "mediafoundation", tuning: if bframes > 0 { "quality" } else { "safe" }, bframes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reorder::DtsClock;

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

    /// What NVENC does with B-frames: pictures leave in decode order carrying their own PTS, and the
    /// decode times come from a `DtsClock` fed the same way the encoder is.
    fn nvenc_like_stream(pictures: i64, gop: i64, bframes: i64) -> Vec<EncodedVideo> {
        let step = bframes + 1;
        let mut order = Vec::new(); // (shown index, is a keyframe, is a reference)
        let mut group = 0;
        while group < pictures {
            let end = (group + gop).min(pictures);
            order.push((group, true, true));
            let mut anchor = group;
            while anchor + 1 < end {
                let next = (anchor + step).min(end - 1);
                order.push((next, false, true));
                for shown in anchor + 1..next {
                    order.push((shown, false, shown == anchor + 1 && next - anchor == 3));
                }
                anchor = next;
            }
            group = end;
        }
        let mut clock = DtsClock::new(bframes as u32, FRAME);
        for i in 0..pictures {
            clock.picture_in(i * FRAME);
        }
        order
            .into_iter()
            .map(|(shown, keyframe, reference)| {
                let dts = clock.picture_out();
                if keyframe {
                    key(shown * FRAME, dts)
                } else {
                    inter(shown * FRAME, dts, if reference { 2 } else { 0 })
                }
            })
            .collect()
    }

    #[test]
    fn nvenc_style_b_frames_give_rising_decode_times_and_never_negative_composition_offsets() {
        let queue = Arc::new(PacketQueue::lossless());
        let mut mux = VideoMux::new(queue.clone(), 2, 60);
        for e in nvenc_like_stream(400, 120, 2) {
            mux.push(e);
        }
        let got = drain(&queue);
        // The first GOP: the very first decode time is two frames before the first picture is shown.
        assert_eq!(shift_of(&got), 33, "the sound is delayed by two frames to match");
        let t = times(&got);
        assert_eq!(t.len(), 400);
        assert_eq!(t[0], (0, 33), "the keyframe is decoded at 0 and shown 33 ms later");
        let mut last = -1;
        for (i, (dts, cts)) in t.iter().enumerate() {
            assert!(*dts > last, "decode time {dts} after {last} at picture {i}");
            assert!(*cts >= 0, "composition offset {cts} at picture {i}");
            last = *dts;
        }
        // Shown time = decode time + offset must cover each shown time once: the multiset of shown
        // times is the capture times (plus the shift), 0 to 399 frames.
        let mut shown: Vec<i64> = t.iter().map(|(d, c)| d + i64::from(*c)).collect();
        shown.sort_unstable();
        assert!(shown.windows(2).all(|w| w[1] > w[0]), "no two pictures are shown at the same time");
        assert_eq!(shown[0], 33);
        assert_eq!(*shown.last().unwrap(), (399 * FRAME + 2 * FRAME) / 10_000);
    }

    #[test]
    fn keyframes_stay_exactly_a_gop_apart_in_time() {
        let queue = Arc::new(PacketQueue::lossless());
        let mut mux = VideoMux::new(queue.clone(), 2, 60);
        for e in nvenc_like_stream(480, 120, 2) {
            mux.push(e);
        }
        let got = drain(&queue);
        let keys: Vec<i64> = got.iter().filter_map(|p| if let Packet::Video { dts_ms, keyframe: true, .. } = p { Some(*dts_ms) } else { None }).collect();
        assert_eq!(keys.len(), 4);
        for pair in keys.windows(2) {
            // 120 frames at 60 fps is two seconds; the rounding to milliseconds can move it by one.
            assert!((pair[1] - pair[0] - 2000).abs() <= 1, "{keys:?}");
        }
    }

    #[test]
    fn after_a_slow_connection_cuts_the_line_back_a_playable_stream_remains() {
        let queue = Arc::new(PacketQueue::new());
        let mut mux = VideoMux::new(queue.clone(), 2, 60);
        // 600 pictures (10 s) with a keyframe every 2 s, pushed without anything being taken: the line is
        // cut back to the newest keyframe whenever it holds more than 1.5 s.
        for e in nvenc_like_stream(600, 120, 2) {
            mux.push(e);
        }
        let got = drain(&queue);
        let t = times(&got);
        assert!(queue.dropped.load(Ordering::Relaxed) > 0);
        assert!(queue.want_keyframe.load(Ordering::Relaxed));
        assert!(matches!(got[0], Packet::VideoHeader { .. }));
        // (If the last cut left nothing, the line is waiting for the next keyframe and holds no video yet.)
        if let Some(first) = got.iter().find(|p| matches!(p, Packet::Video { .. })) {
            assert!(matches!(first, Packet::Video { keyframe: true, .. }), "what is left starts at a keyframe");
        }
        let mut last = -1;
        for (dts, cts) in t {
            assert!(dts > last && cts >= 0);
            last = dts;
        }
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
    fn the_extra_progress_lines_name_the_encoder() {
        // The lines are built from an encoder; here only the shape of the text is checked.
        let lines = "encoder_backend=nvenc\nencoder_name=NVIDIA NVENC\nencoder_bframes=2\nencoder_tuning=quality\nsource=screen\n";
        let p = Progress { frames: 1, extra: lines.to_string(), ..Default::default() };
        let block = p.block(false);
        assert!(block.contains("encoder_backend=nvenc\n") && block.ends_with("progress=continue\n"));
        // The server's parser takes the keys it knows and skips the rest.
        assert!(block.contains("frame=1\n"));
    }
}
