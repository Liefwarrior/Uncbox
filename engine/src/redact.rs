//! Keeping the stream key out of everything the engine prints.
//!
//! The ingest address holds the key, so it arrives on stdin (not in the arguments, where any program
//! on the PC can read it) and every line the engine prints goes through [`redact`] first. Twitch keys
//! look like `live_<channel number>_<letters and digits>`; for other services the exact secret is
//! registered with [`add_secret`] and blanked wherever it shows up.

use std::sync::{Mutex, OnceLock};

fn secrets() -> &'static Mutex<Vec<String>> {
    static SECRETS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    SECRETS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Remembers a string (a stream key, a whole ingest address) that must never be printed.
pub fn add_secret(secret: &str) {
    let secret = secret.trim();
    if secret.len() < 4 {
        return;
    }
    if let Ok(mut all) = secrets().lock() {
        for form in [secret.to_string(), percent_encode(secret)] {
            if !all.contains(&form) {
                all.push(form);
            }
        }
    }
}

fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Blanks anything shaped like a Twitch stream key: `live_` + digits + `_` + letters and digits.
pub fn redact_shapes(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"live_") {
            let mut j = i + 5;
            let digits_start = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > digits_start && j < bytes.len() && bytes[j] == b'_' {
                let mut k = j + 1;
                let tail_start = k;
                while k < bytes.len() && bytes[k].is_ascii_alphanumeric() {
                    k += 1;
                }
                if k > tail_start {
                    out.push_str("live_****");
                    i = k;
                    continue;
                }
            }
        }
        // Copy one whole character (the text may hold non-ASCII).
        let ch_len = text[i..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// The text with every registered secret and anything shaped like a stream key blanked out.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    if let Ok(all) = secrets().lock() {
        // Longest first, so an address is blanked whole before the key inside it.
        let mut sorted: Vec<&String> = all.iter().collect();
        sorted.sort_by_key(|s| std::cmp::Reverse(s.len()));
        for secret in sorted {
            out = out.replace(secret.as_str(), "****");
        }
    }
    redact_shapes(&out)
}

/// A line for the page to show: redacted, on one line.
pub fn clean_line(text: &str) -> String {
    redact(text).split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blanks_twitch_shaped_keys() {
        assert_eq!(redact_shapes("key live_55_abcdefghij12 end"), "key live_**** end");
        assert_eq!(
            redact_shapes("rtmps://live.twitch.tv:443/app/live_123456789_AbCdEfGhIjKlMnOpQrSt?bandwidthtest=true"),
            "rtmps://live.twitch.tv:443/app/live_****?bandwidthtest=true"
        );
        assert_eq!(redact_shapes("live_1_a and live_22_b"), "live_**** and live_****");
    }

    #[test]
    fn leaves_other_text_alone() {
        for text in ["Connection reset by peer", "live_stream", "live_12", "live_12_", "alive_stream", "héllo live"] {
            assert_eq!(redact_shapes(text), text);
        }
    }

    #[test]
    fn keeps_non_ascii_text_whole() {
        assert_eq!(redact_shapes("Zugriff verweigert — live_9_zz"), "Zugriff verweigert — live_****");
    }

    #[test]
    fn blanks_registered_secrets_in_every_form() {
        add_secret("sup3r/secret-key");
        let line = redact("failed to open rtmp://x/app/sup3r/secret-key and sup3r%2Fsecret-key");
        assert!(!line.contains("secret-key"), "{line}");
        assert!(!line.contains("sup3r"), "{line}");
    }

    #[test]
    fn clean_line_is_one_line() {
        assert_eq!(clean_line("a\r\n  b\tc live_5_xyz"), "a b c live_****");
    }
}
