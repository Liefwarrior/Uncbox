//! What `uncbox-stream probe` prints: one line of JSON describing the graphics cards, their screens
//! and what the hardware encoders can do. The facts come from the graphics card (see
//! `pipeline::probe_json`); this is only the shape they are reported in, so the contract with the
//! server (server/stream.mjs) can be tested without a card.
//!
//! ```json
//! { "version": "0.2.0",
//!   "adapters": [ { "name": "NVIDIA GeForce RTX 5090 Laptop GPU", "vendor": "nvidia",
//!                   "outputs": [ { "index": 0, "width": 2560, "height": 1440, "primary": true } ],
//!                   "encoder": { "backend": "nvenc", "tuning": "quality", "bframes": 2 } } ],
//!   "encoders": ["nvidia"],
//!   "backend": { "nvidia": "nvenc" },
//!   "tuning": { "nvidia": "quality" },
//!   "primary": 0 }
//! ```
//!
//! `encoders` lists the makers whose hardware H.264 encoder really encoded a few dozen tiny test
//! pictures. `backend` is `nvenc` (the direct NVIDIA encoder) or `mediafoundation`; `tuning` is
//! `quality` (the full FFmpeg-equivalent settings were taken) or `safe` (the card or driver refused
//! part of them). `primary` is the number of the screen Windows calls the main one, or null.

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOutput {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// What a test encode showed about an adapter's encoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderCheck {
    pub backend: &'static str,
    pub tuning: &'static str,
    pub bframes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeAdapter {
    pub name: String,
    pub vendor: &'static str,
    pub outputs: Vec<ProbeOutput>,
    /// `None` when the adapter's encoder wasn't tried (no screens on it, or a maker Uncbox doesn't know) or didn't work.
    pub check: Option<EncoderCheck>,
}

pub fn to_json(version: &str, adapters: &[ProbeAdapter]) -> Value {
    let mut encoders: Vec<&'static str> = Vec::new();
    let mut backends = Map::new();
    let mut tunings = Map::new();
    for adapter in adapters {
        if let Some(check) = &adapter.check {
            // The first card of a maker decides for the maker (a second one would say the same).
            if !encoders.contains(&adapter.vendor) {
                encoders.push(adapter.vendor);
                backends.insert(adapter.vendor.to_string(), check.backend.into());
                tunings.insert(adapter.vendor.to_string(), check.tuning.into());
            }
        }
    }
    let listed: Vec<Value> = adapters
        .iter()
        .map(|a| {
            json!({
                "name": a.name,
                "vendor": a.vendor,
                "outputs": a.outputs.iter().map(|o| json!({ "index": o.index, "width": o.width, "height": o.height, "primary": o.primary })).collect::<Vec<_>>(),
                "encoder": a.check.as_ref().map(|c| json!({ "backend": c.backend, "tuning": c.tuning, "bframes": c.bframes })),
            })
        })
        .collect();
    let primary = adapters.iter().flat_map(|a| a.outputs.iter()).find(|o| o.primary).map(|o| o.index);
    json!({
        "version": version,
        "adapters": listed,
        "encoders": encoders,
        "backend": backends,
        "tuning": tunings,
        "primary": primary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(index: u32, primary: bool) -> ProbeOutput {
        ProbeOutput { index, width: 2560, height: 1440, primary }
    }

    fn nvidia() -> ProbeAdapter {
        ProbeAdapter {
            name: "NVIDIA GeForce RTX 5090 Laptop GPU".into(),
            vendor: "nvidia",
            outputs: vec![out(0, false), out(1, true)],
            check: Some(EncoderCheck { backend: "nvenc", tuning: "quality", bframes: 2 }),
        }
    }

    #[test]
    fn reports_screens_encoders_backend_tuning_and_the_primary_screen() {
        let v = to_json("0.2.0", &[nvidia()]);
        assert_eq!(v["version"], "0.2.0");
        assert_eq!(v["encoders"], json!(["nvidia"]));
        assert_eq!(v["backend"], json!({ "nvidia": "nvenc" }));
        assert_eq!(v["tuning"], json!({ "nvidia": "quality" }));
        assert_eq!(v["primary"], 1, "the screen numbered 1 is the one Windows calls primary");
        let a = &v["adapters"][0];
        assert_eq!(a["vendor"], "nvidia");
        assert_eq!(a["outputs"][1], json!({ "index": 1, "width": 2560, "height": 1440, "primary": true }));
        assert_eq!(a["outputs"][0]["primary"], false);
        assert_eq!(a["encoder"], json!({ "backend": "nvenc", "tuning": "quality", "bframes": 2 }));
    }

    #[test]
    fn an_older_card_reports_the_safe_settings_and_a_media_foundation_card_says_so() {
        let older = ProbeAdapter { check: Some(EncoderCheck { backend: "nvenc", tuning: "safe", bframes: 2 }), ..nvidia() };
        assert_eq!(to_json("x", &[older])["tuning"]["nvidia"], "safe");
        let amd = ProbeAdapter {
            name: "AMD Radeon".into(),
            vendor: "amd",
            outputs: vec![out(0, true)],
            check: Some(EncoderCheck { backend: "mediafoundation", tuning: "safe", bframes: 0 }),
        };
        let v = to_json("x", &[amd]);
        assert_eq!(v["encoders"], json!(["amd"]));
        assert_eq!(v["backend"], json!({ "amd": "mediafoundation" }));
        assert_eq!(v["adapters"][0]["encoder"]["bframes"], 0);
    }

    #[test]
    fn a_card_that_wasnt_tried_or_failed_has_a_null_encoder_and_isnt_listed() {
        let intel = ProbeAdapter { name: "Intel(R) Graphics".into(), vendor: "intel", outputs: vec![], check: None };
        let v = to_json("x", &[nvidia(), intel]);
        assert_eq!(v["encoders"], json!(["nvidia"]));
        assert!(v["adapters"][1]["encoder"].is_null());
        assert_eq!(v["adapters"][1]["outputs"], json!([]));
        assert!(v["backend"].get("intel").is_none());
    }

    #[test]
    fn two_cards_of_one_maker_are_listed_once() {
        let v = to_json("x", &[nvidia(), nvidia()]);
        assert_eq!(v["encoders"], json!(["nvidia"]));
        assert_eq!(v["adapters"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn no_cards_or_no_primary_screen_is_empty_and_null() {
        let v = to_json("x", &[]);
        assert_eq!(v["adapters"], json!([]));
        assert_eq!(v["encoders"], json!([]));
        assert!(v["primary"].is_null());
        let no_primary = ProbeAdapter { outputs: vec![out(0, false)], ..nvidia() };
        assert!(to_json("x", &[no_primary])["primary"].is_null());
    }

    #[test]
    fn the_old_keys_are_still_there_for_the_server() {
        // server/stream.mjs reads `encoders` and, per adapter, name, vendor and outputs (index, width, height, primary).
        let v = to_json("x", &[nvidia()]);
        for key in ["version", "adapters", "encoders"] {
            assert!(v.get(key).is_some(), "{key}");
        }
        for key in ["name", "vendor", "outputs"] {
            assert!(v["adapters"][0].get(key).is_some(), "{key}");
        }
        for key in ["index", "width", "height", "primary"] {
            assert!(v["adapters"][0]["outputs"][0].get(key).is_some(), "{key}");
        }
    }
}
