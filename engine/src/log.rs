//! Messages for the person (stderr, one plain line each) and for whoever is working on the engine
//! (only when `UNCBOX_STREAM_DEBUG` is set). Both are run through the stream key filter first.

use crate::redact;

/// A warning or the reason a stream stopped. The page shows the last line printed.
pub fn warn(text: &str) {
    eprintln!("{}", redact::clean_line(text));
}

pub fn debug(text: &str) {
    if std::env::var_os("UNCBOX_STREAM_DEBUG").is_some() {
        eprintln!("[debug] {}", redact::clean_line(text));
    }
}
