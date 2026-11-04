//! Stealth mode's picture: the Uncbox dashboard, captured as a window, with the game's own window
//! drawn over the dashboard's game panel. This is what OBS calls a scene, made by the graphics
//! card's video processor in the same pass that turns the picture into what the encoder takes (see
//! `convert.rs`), so it costs no more copies than streaming a screen does.
//!
//! In stealth mode the person plays the game full screen while the dashboard keeps running behind it
//! at its own size; viewers get the dashboard with the game in its panel, as if Uncbox were on the
//! screen. The app (native/UncboxShell) knows both windows and where the panel is, and the server
//! passes that on, at the start (`"source": { "scene": … }`) and whenever it changes (a line
//! `{"scene": …}` on stdin; `{"scene": null}` goes back to the screen).
//!
//! This file is only the description and the arithmetic, so it is tested without Windows:
//!
//! ```json
//! { "window": "1234", "cursor": false, "size": { "w": 2560, "h": 1440 },
//!   "game": { "window": "5678", "rect": { "x": 0, "y": 0, "w": 1707, "h": 900 },
//!             "crop": { "top": 0, "right": 0, "bottom": 0, "left": 0 }, "stripPx": 5, "fit": "contain" } }
//! ```
//!
//! - `window`: the dashboard's window handle (a number, or digits in a string as the page has it).
//! - `cursor`: draw the mouse pointer where it is over the dashboard. Off in stealth mode, where the
//!   pointer is over the game (the game's own capture draws it there, scaled into the panel).
//! - `size`: the dashboard's size `rect` was measured at, in device pixels. A picture of another
//!   size (the window is being resized) scales the panel with it.
//! - `game.rect`: the game panel, in the dashboard's device pixels.
//! - `game.crop`: percent of the game's picture left out at each edge (the panel's Crop), 0 to 45.
//! - `game.stripPx`: rows at the top of the game's picture that are the WoW addon's strip, which
//!   viewers never see.
//! - `game.fit`: `contain` (the whole game, bars where the shapes differ), `cover` (fills the
//!   panel, trimming the game's edges) or `stretch`.

use crate::orient::Rect;
use serde_json::Value;

/// The share of the game's picture left out at each edge, each 0 to 0.45.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Crop {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// How the game's picture fills the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Fit {
    #[default]
    Contain,
    Cover,
    Stretch,
}

/// The game's own window, drawn over the panel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GameLayer {
    /// The game window's handle.
    pub window: isize,
    /// The panel in the dashboard's device pixels.
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub crop: Crop,
    pub strip_px: u32,
    pub fit: Fit,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scene {
    /// The dashboard's window handle.
    pub window: isize,
    pub cursor: bool,
    /// The dashboard size the game's rect was measured at (0 x 0: whatever the picture is).
    pub size: (u32, u32),
    pub game: Option<GameLayer>,
}

/// The biggest picture any of this is allowed to describe, on either side.
const MAX_SIDE: f64 = 16384.0;

/// A window handle from the page: a positive whole number, as a number or as digits in a string.
/// Handles are 32-bit values on Windows, so anything far past that is not one.
fn handle(value: Option<&Value>) -> Option<isize> {
    let n: u64 = match value? {
        Value::Number(n) => n.as_u64()?,
        Value::String(s) => s.trim().parse().ok()?,
        _ => return None,
    };
    (1..=0xFFFF_FFFF_FFFF).contains(&n).then_some(n as isize)
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// The percent of one edge, held to 0 to 45 (as the app holds the panel's crop), as a share.
fn edge(crop: Option<&Value>, name: &str) -> f64 {
    number(crop.and_then(|c| c.get(name))).unwrap_or(0.0).clamp(0.0, 45.0) / 100.0
}

impl Fit {
    pub fn parse(name: &str) -> Fit {
        match name.trim().to_ascii_lowercase().as_str() {
            "cover" | "fill" => Fit::Cover,
            "stretch" => Fit::Stretch,
            _ => Fit::Contain,
        }
    }
}

impl GameLayer {
    fn from_value(value: &Value) -> Option<GameLayer> {
        let window = handle(value.get("window"))?;
        let rect = value.get("rect")?;
        let (x, y, w, h) = (number(rect.get("x"))?, number(rect.get("y"))?, number(rect.get("w"))?, number(rect.get("h"))?);
        if !(2.0..=MAX_SIDE).contains(&w.round()) || !(2.0..=MAX_SIDE).contains(&h.round()) || x.abs() > MAX_SIDE || y.abs() > MAX_SIDE {
            return None;
        }
        let crop = value.get("crop");
        Some(GameLayer {
            window,
            x: x.round() as i32,
            y: y.round() as i32,
            w: w.round() as u32,
            h: h.round() as u32,
            crop: Crop { top: edge(crop, "top"), right: edge(crop, "right"), bottom: edge(crop, "bottom"), left: edge(crop, "left") },
            strip_px: number(value.get("stripPx")).unwrap_or(0.0).clamp(0.0, 256.0).round() as u32,
            fit: value.get("fit").and_then(Value::as_str).map(Fit::parse).unwrap_or_default(),
        })
    }
}

impl Scene {
    /// A scene from its JSON, or `None` when it isn't a usable one (no dashboard window). A game
    /// that isn't described well enough is left out rather than guessed at: the dashboard alone
    /// still shows the stream.
    pub fn from_value(value: &Value) -> Option<Scene> {
        let window = handle(value.get("window"))?;
        let size = value.get("size").map_or((0, 0), |s| {
            let side = |name: &str| number(s.get(name)).map_or(0, |n| n.round().clamp(0.0, MAX_SIDE) as u32);
            (side("w"), side("h"))
        });
        Some(Scene {
            window,
            cursor: value.get("cursor").and_then(Value::as_bool).unwrap_or(false),
            size,
            game: value.get("game").and_then(GameLayer::from_value),
        })
    }

    /// What a line on the engine's stdin says about the scene: `Some(Some(scene))` to show this
    /// scene, `Some(None)` (for `{"scene": null}`) to go back to the screen, and `None` for a line
    /// that says nothing usable about it (which changes nothing).
    pub fn update_from_line(line: &str) -> Option<Option<Scene>> {
        let line = line.trim();
        if !line.starts_with('{') {
            return None;
        }
        let value: Value = serde_json::from_str(line).ok()?;
        match value.get("scene")? {
            Value::Null => Some(None),
            scene => Scene::from_value(scene).map(Some),
        }
    }
}

/// Where the game goes in the picture that is sent, and which part of the game's own picture is
/// drawn there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    /// In the game's own picture.
    pub source: Rect,
    /// In the picture that is sent. Every edge is even, as 4:2:0 video needs.
    pub dest: Rect,
}

/// A rectangle in fractional pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Area {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Area {
    fn w(&self) -> f64 {
        self.x1 - self.x0
    }

    fn h(&self) -> f64 {
        self.y1 - self.y0
    }

    /// The largest rectangle of the shape `aspect` (width over height) centred inside this one.
    fn fitted(&self, aspect: f64) -> Area {
        let (cx, cy) = ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0);
        let (w, h) = if self.w() / self.h() > aspect { (self.h() * aspect, self.h()) } else { (self.w(), self.w() / aspect) };
        Area { x0: cx - w / 2.0, y0: cy - h / 2.0, x1: cx + w / 2.0, y1: cy + h / 2.0 }
    }
}

/// Where the game's picture goes when the dashboard's picture is `dash` pixels, the game's own is
/// `game` and the picture sent is `out` (the dashboard fitted into it at its own shape, as
/// `orient::fit` places it). `None` when the panel isn't on the picture at all, or either picture
/// has no size.
pub fn place_game(scene: &Scene, dash: (u32, u32), game: (u32, u32), out: (u32, u32)) -> Option<Placement> {
    let layer = scene.game.as_ref()?;
    let (dw, dh) = (f64::from(dash.0), f64::from(dash.1));
    let (gw, gh) = (f64::from(game.0), f64::from(game.1));
    if dw < 2.0 || dh < 2.0 || gw < 2.0 || gh < 2.0 || out.0 < 2 || out.1 < 2 {
        return None;
    }

    // The part of the game's picture that shows: the strip off the top, then the crop of what's left.
    let strip = f64::from(layer.strip_px).min(gh - 2.0);
    let inner_h = gh - strip;
    let c = layer.crop;
    let mut src = Area { x0: gw * c.left, y0: strip + inner_h * c.top, x1: gw * (1.0 - c.right), y1: gh - inner_h * c.bottom };
    if src.w() < 2.0 || src.h() < 2.0 {
        return None;
    }

    // The panel on the picture that is sent: measured on a dashboard of `scene.size`, which is
    // scaled onto the dashboard picture as it is now, which sits in `out` where `fit` put it.
    let (mw, mh) = if scene.size.0 >= 2 && scene.size.1 >= 2 { (f64::from(scene.size.0), f64::from(scene.size.1)) } else { (dw, dh) };
    let placed = crate::orient::fit(dash.0, dash.1, out.0, out.1);
    let (sx, sy) = (f64::from(placed.width()) / mw, f64::from(placed.height()) / mh);
    let (ox, oy) = (f64::from(placed.left), f64::from(placed.top));
    let mut dest = Area {
        x0: ox + f64::from(layer.x) * sx,
        y0: oy + f64::from(layer.y) * sy,
        x1: ox + (f64::from(layer.x) + f64::from(layer.w)) * sx,
        y1: oy + (f64::from(layer.y) + f64::from(layer.h)) * sy,
    };
    if dest.w() < 2.0 || dest.h() < 2.0 {
        return None;
    }

    match layer.fit {
        Fit::Stretch => {}
        // The whole game, at its own shape, in the middle of the panel.
        Fit::Contain => dest = dest.fitted(src.w() / src.h()),
        // The panel full, the game's edges trimmed to its shape.
        Fit::Cover => src = src.fitted(dest.w() / dest.h()),
    }

    // Only the part of the panel that is on the dashboard's picture is drawn, and the game's
    // picture is trimmed to match.
    let bounds = Area { x0: ox, y0: oy, x1: ox + f64::from(placed.width()), y1: oy + f64::from(placed.height()) };
    let (kx, ky) = (src.w() / dest.w(), src.h() / dest.h());
    let clipped = Area { x0: dest.x0.max(bounds.x0), y0: dest.y0.max(bounds.y0), x1: dest.x1.min(bounds.x1), y1: dest.y1.min(bounds.y1) };
    if clipped.w() < 2.0 || clipped.h() < 2.0 {
        return None;
    }
    src = Area {
        x0: src.x0 + (clipped.x0 - dest.x0) * kx,
        y0: src.y0 + (clipped.y0 - dest.y0) * ky,
        x1: src.x1 - (dest.x1 - clipped.x1) * kx,
        y1: src.y1 - (dest.y1 - clipped.y1) * ky,
    };

    // Whole pixels: the panel's edges on even ones (inside the picture), the game's to the nearest.
    let even_down = |v: f64| ((v.max(0.0) as u32) / 2) * 2;
    let even_up = |v: f64, limit: u32| ((v.max(0.0).ceil() as u32).div_ceil(2) * 2).min(limit / 2 * 2);
    // Outward, so the panel is always covered: in Play here the dashboard's own picture has a hole there.
    let d = Rect { left: even_down(clipped.x0), top: even_down(clipped.y0), right: even_up(clipped.x1, out.0), bottom: even_up(clipped.y1, out.1) };
    let near = |v: f64, limit: u32| (v.round().max(0.0) as u32).min(limit);
    let s = Rect { left: near(src.x0, game.0), top: near(src.y0, game.1), right: near(src.x1, game.0), bottom: near(src.y1, game.1) };
    if d.right < d.left + 2 || d.bottom < d.top + 2 || s.right <= s.left || s.bottom <= s.top {
        return None;
    }
    Some(Placement { source: s, dest: d })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scene(game: Value) -> Scene {
        Scene::from_value(&json!({ "window": 100, "size": { "w": 1920, "h": 1080 }, "game": game })).expect("a scene")
    }

    fn panel(x: f64, y: f64, w: f64, h: f64) -> Value {
        json!({ "window": "200", "rect": { "x": x, "y": y, "w": w, "h": h } })
    }

    fn rect(left: u32, top: u32, right: u32, bottom: u32) -> Rect {
        Rect { left, top, right, bottom }
    }

    #[test]
    fn reads_the_scene_the_app_describes() {
        let s = Scene::from_value(&json!({
            "window": "1234", "cursor": true, "size": { "w": 2560, "h": 1440 },
            "game": { "window": 5678, "rect": { "x": 10.4, "y": 20.6, "w": 1706.7, "h": 900 },
                      "crop": { "top": 5, "right": 60, "bottom": -3, "left": "x" }, "stripPx": 5.2, "fit": "Cover" }
        }))
        .unwrap();
        assert_eq!((s.window, s.cursor, s.size), (1234, true, (2560, 1440)));
        let g = s.game.unwrap();
        assert_eq!((g.window, g.x, g.y, g.w, g.h, g.strip_px, g.fit), (5678, 10, 21, 1707, 900, 5, Fit::Cover));
        // Each edge held to 0..45 percent, as the app holds the panel's crop; nonsense is no crop.
        assert_eq!(g.crop, Crop { top: 0.05, right: 0.45, bottom: 0.0, left: 0.0 });
    }

    #[test]
    fn a_scene_needs_a_real_dashboard_window() {
        for bad in [
            json!({}),
            json!({ "window": 0 }),
            json!({ "window": -5 }),
            json!({ "window": "12a" }),
            json!({ "window": 1.5 }),
            json!({ "window": [] }),
            json!(null),
        ] {
            assert_eq!(Scene::from_value(&bad), None, "{bad}");
        }
        assert_eq!(Scene::from_value(&json!({ "window": 1u64 << 49 })), None, "far past any handle");
        let plain = Scene::from_value(&json!({ "window": 7 })).unwrap();
        assert_eq!((plain.cursor, plain.size, plain.game), (false, (0, 0), None));
    }

    #[test]
    fn a_game_that_is_not_described_well_enough_is_left_out() {
        for game in [
            json!({ "rect": { "x": 0, "y": 0, "w": 100, "h": 100 } }),
            json!({ "window": 9 }),
            json!({ "window": 9, "rect": { "x": 0, "y": 0, "w": 1, "h": 100 } }),
            json!({ "window": 9, "rect": { "x": 0, "y": 0, "w": 100, "h": 99999 } }),
            json!({ "window": 9, "rect": { "x": 1e9, "y": 0, "w": 100, "h": 100 } }),
            json!({ "window": 9, "rect": { "x": "0", "y": 0, "w": 100, "h": 100 } }),
        ] {
            assert_eq!(Scene::from_value(&json!({ "window": 7, "game": game })).unwrap().game, None, "{game}");
        }
        assert_eq!(Fit::parse("stretch"), Fit::Stretch);
        assert_eq!(Fit::parse("fill"), Fit::Cover);
        assert_eq!(Fit::parse("??"), Fit::Contain);
    }

    #[test]
    fn stdin_lines_change_the_scene_only_when_they_mean_to() {
        assert_eq!(Scene::update_from_line("q"), None);
        assert_eq!(Scene::update_from_line(""), None);
        assert_eq!(Scene::update_from_line("{not json"), None);
        assert_eq!(Scene::update_from_line(r#"{"other":1}"#), None);
        assert_eq!(Scene::update_from_line(r#"{"scene":{"window":0}}"#), None, "a bad scene changes nothing");
        assert_eq!(Scene::update_from_line(r#"{"scene":null}"#), Some(None));
        let s = Scene::update_from_line(r#" {"scene":{"window":"42"}} "#).unwrap().unwrap();
        assert_eq!(s.window, 42);
    }

    #[test]
    fn play_here_maps_the_game_one_to_one() {
        // The game window is the panel's size, the dashboard is what is sent: nothing scales.
        let s = scene(panel(0.0, 0.0, 1280.0, 720.0));
        let p = place_game(&s, (1920, 1080), (1280, 720), (1920, 1080)).unwrap();
        assert_eq!(p, Placement { source: rect(0, 0, 1280, 720), dest: rect(0, 0, 1280, 720) });
    }

    #[test]
    fn a_full_screen_game_fits_inside_the_panel() {
        // WoW's 16 x 15 game panel on a 1920 x 1080 dashboard is 1280 x 675; the game is a 16:9 screen.
        let s = scene(panel(0.0, 0.0, 1280.0, 675.0));
        let p = place_game(&s, (1920, 1080), (2560, 1440), (1920, 1080)).unwrap();
        assert_eq!(p.source, rect(0, 0, 2560, 1440));
        // 675 tall at 16:9 is 1200 wide, centred: 40 px of panel each side.
        assert_eq!(p.dest, rect(40, 0, 1240, 676));
    }

    #[test]
    fn cover_fills_the_panel_and_trims_the_game() {
        let mut s = scene(panel(0.0, 0.0, 1280.0, 675.0));
        s.game.as_mut().unwrap().fit = Fit::Cover;
        let p = place_game(&s, (1920, 1080), (2560, 1440), (1920, 1080)).unwrap();
        assert_eq!(p.dest, rect(0, 0, 1280, 676));
        // The game's 2560 width at the panel's shape is 1350 tall: 45 rows trimmed top and bottom.
        assert_eq!(p.source, rect(0, 45, 2560, 1395));
        s.game.as_mut().unwrap().fit = Fit::Stretch;
        let p = place_game(&s, (1920, 1080), (2560, 1440), (1920, 1080)).unwrap();
        assert_eq!((p.source, p.dest), (rect(0, 0, 2560, 1440), rect(0, 0, 1280, 676)));
    }

    #[test]
    fn the_wow_strip_and_the_crop_never_reach_viewers() {
        let s = scene(
            json!({ "window": 2, "rect": { "x": 0, "y": 0, "w": 1000, "h": 500 }, "crop": { "top": 10, "bottom": 10, "left": 5, "right": 5 }, "stripPx": 8, "fit": "stretch" }),
        );
        let p = place_game(&s, (1920, 1080), (2000, 1008), (1920, 1080)).unwrap();
        // 8 strip rows off the top, then 10% of the remaining 1000 rows each end; 5% of the width each side.
        assert_eq!(p.source, rect(100, 108, 1900, 908));
    }

    #[test]
    fn the_panel_scales_with_the_dashboard_into_the_picture_sent() {
        // A 2560 x 1440 dashboard sent at 1080p: the panel shrinks by three quarters with it.
        let mut s = scene(panel(100.0, 200.0, 1600.0, 900.0));
        s.size = (2560, 1440);
        let p = place_game(&s, (2560, 1440), (1600, 900), (1920, 1080)).unwrap();
        assert_eq!(p.dest, rect(74, 150, 1276, 826));
        // Measured at 2560 x 1440 but the picture came at 1280 x 720 (mid-resize): the same place on the sent picture.
        let q = place_game(&s, (1280, 720), (1600, 900), (1920, 1080)).unwrap();
        assert_eq!(q.dest, p.dest);
    }

    #[test]
    fn a_dashboard_of_another_shape_keeps_its_bars() {
        // A 4:3 dashboard in a 16:9 picture sits in the middle (240 px each side at 1080p).
        let mut s = scene(panel(0.0, 0.0, 720.0, 540.0));
        s.size = (1440, 1080);
        let p = place_game(&s, (1440, 1080), (720, 540), (1920, 1080)).unwrap();
        assert_eq!(p.dest, rect(240, 0, 960, 540));
    }

    #[test]
    fn a_panel_partly_off_the_dashboard_is_trimmed_with_its_game() {
        let s = scene(json!({ "window": 2, "rect": { "x": -200, "y": 0, "w": 800, "h": 400 }, "fit": "stretch" }));
        let p = place_game(&s, (1920, 1080), (1600, 800), (1920, 1080)).unwrap();
        assert_eq!(p.dest, rect(0, 0, 600, 400));
        // A quarter of the panel is off the left edge, so a quarter of the game is too.
        assert_eq!(p.source, rect(400, 0, 1600, 800));
        let gone = scene(panel(5000.0, 0.0, 300.0, 300.0));
        assert_eq!(place_game(&gone, (1920, 1080), (1600, 800), (1920, 1080)), None);
    }

    #[test]
    fn every_edge_is_even_and_inside_the_picture() {
        for (x, y, w, h) in [(1.0, 3.0, 641.0, 359.0), (333.3, 77.7, 1001.0, 503.0), (1700.0, 900.0, 600.0, 600.0)] {
            for game in [(2560, 1440), (1366, 768), (3440, 1440)] {
                for out in [(1920, 1080), (1280, 720), (2560, 1440)] {
                    let s = scene(panel(x, y, w, h));
                    let Some(p) = place_game(&s, (1920, 1080), game, out) else { continue };
                    let d = p.dest;
                    assert!(d.left % 2 == 0 && d.top % 2 == 0 && d.right % 2 == 0 && d.bottom % 2 == 0, "{d:?}");
                    assert!(d.right <= out.0 && d.bottom <= out.1 && d.width() >= 2 && d.height() >= 2, "{d:?}");
                    let src = p.source;
                    assert!(src.right <= game.0 && src.bottom <= game.1 && src.width() >= 1 && src.height() >= 1, "{src:?}");
                }
            }
        }
    }

    #[test]
    fn no_game_or_no_picture_places_nothing() {
        let plain = Scene::from_value(&json!({ "window": 7 })).unwrap();
        assert_eq!(place_game(&plain, (1920, 1080), (1920, 1080), (1920, 1080)), None);
        let s = scene(panel(0.0, 0.0, 100.0, 100.0));
        assert_eq!(place_game(&s, (0, 0), (100, 100), (1920, 1080)), None);
        assert_eq!(place_game(&s, (1920, 1080), (0, 0), (1920, 1080)), None);
        // A strip and crop that leave nothing of the game.
        let none_left = scene(
            json!({ "window": 2, "rect": { "x": 0, "y": 0, "w": 100, "h": 100 }, "crop": { "top": 45, "bottom": 45, "left": 45, "right": 45 }, "stripPx": 256 }),
        );
        assert_eq!(place_game(&none_left, (1920, 1080), (300, 258), (1920, 1080)), None);
    }
}
