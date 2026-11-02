//! `uncbox-stream`: Uncbox's own streaming engine, a drop-in for the FFmpeg process that
//! server/stream.mjs used to run.
//!
//!   uncbox-stream probe    prints one line of JSON: the graphics cards, their screens, and which
//!                          hardware encoders work
//!   uncbox-stream run      reads one line of JSON settings on stdin (see settings.rs), then
//!                          streams, printing FFmpeg-style progress on stdout every second.
//!                          A line "q" on stdin (or closing stdin) ends it cleanly.
//!
//! Problems are one plain sentence on stderr and a non-zero exit code. The stream key arrives on
//! stdin, never in the arguments, and nothing printed ever contains it.

use std::io::BufRead;
use std::process::ExitCode;
use std::sync::mpsc::channel;
use uncbox_stream::redact;
use uncbox_stream::settings::{Settings, Source};

fn usage() -> ExitCode {
    eprintln!("Usage: uncbox-stream probe | uncbox-stream run (settings as one line of JSON on stdin)");
    ExitCode::from(2)
}

#[cfg(windows)]
fn main() -> ExitCode {
    // A panic message could hold anything: print a fixed sentence instead.
    std::panic::set_hook(Box::new(|_| {
        eprintln!("Uncbox's streaming engine hit an unexpected problem.");
    }));
    // Report screens at their real pixel size, not scaled for the display's zoom setting.
    // SAFETY: a plain call made once at startup.
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let command = std::env::args().nth(1).unwrap_or_default();
    match command.as_str() {
        "probe" => {
            println!("{}", uncbox_stream::pipeline::probe_json());
            ExitCode::SUCCESS
        }
        "run" => run(),
        "--version" | "version" => {
            println!("uncbox-stream {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => usage(),
    }
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    eprintln!("Uncbox's streaming engine only runs on Windows.");
    ExitCode::from(1)
}

#[cfg(windows)]
fn run() -> ExitCode {
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
        eprintln!("No stream settings were given.");
        return ExitCode::from(2);
    }
    let settings = match Settings::from_json(&line) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}", redact::clean_line(&e.to_string()));
            return ExitCode::from(2);
        }
    };

    // Windows wakes timers every 15 ms unless asked; the frame clock needs better.
    // SAFETY: a plain call; undone when the process ends.
    unsafe {
        windows::Win32::Media::timeBeginPeriod(1);
    }

    // Closing stdin means the server went away, which ends a stream of the screen. A test run of a video
    // file goes on to its end (only a line "q" stops it), so it can be started with `echo {...} | uncbox-stream run`.
    let eof_stops = settings.source == Source::Screen;
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        // "q" ends the stream; so does the end of stdin (the server went away).
        let mut stopped_by_q = false;
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(l) if l.trim().eq_ignore_ascii_case("q") => {
                    stopped_by_q = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        if eof_stops || stopped_by_q {
            let _ = tx.send(uncbox_stream::pipeline::Control::Stop);
        } else {
            // Keep the channel open (a closed one would also stop the stream) until the program ends.
            loop {
                std::thread::park();
            }
        }
    });

    match uncbox_stream::pipeline::run(settings, rx) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{}", redact::clean_line(&e.to_string()));
            ExitCode::from(1)
        }
    }
}
