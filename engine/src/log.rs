//! Messages for the person (stderr, one plain line each) and for whoever is working on the engine
//! (only when `UNCBOX_STREAM_DEBUG` is set). Both are run through the stream key filter first.

use crate::redact;

/// The reason a stream stopped, in plain words: the page shows the last line printed when a stream
/// drops, so only that goes here. Notes about how the stream is made (which encoder, settings a
/// card refused) go to debug(): they would otherwise be shown as the reason for an unrelated drop,
/// and the person streaming shouldn't have to know which engine is doing it.
pub fn warn(text: &str) {
    eprintln!("{}", redact::clean_line(text));
}

pub fn debug(text: &str) {
    if std::env::var_os("UNCBOX_STREAM_DEBUG").is_some() {
        eprintln!("[debug] {}", redact::clean_line(text));
    }
}
