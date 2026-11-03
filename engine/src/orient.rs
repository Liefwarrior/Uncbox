//! Which way up a screen is, and how a picture of one size sits in another.
//!
//! Windows hands over a rotated screen (a monitor turned on its side) as the picture the graphics
//! card scans out, which is turned from the one the person sees. The engine sends the picture the
//! way the person sees it, so it has to know the turn. This file is only the arithmetic; the video
//! processor does the turning (see `convert.rs`).

/// How far the screen is turned, as `DXGI_MODE_ROTATION` says it: the picture Windows hands over
/// has to be turned this far clockwise to look the way the person sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Rotation {
    #[default]
    None,
    Rotate90,
    Rotate180,
    Rotate270,
}

impl Rotation {
    /// From the number DXGI uses (1 = not rotated, 2 = 90, 3 = 180, 4 = 270; 0 is "unspecified").
    pub fn from_dxgi(value: i32) -> Rotation {
        match value {
            2 => Rotation::Rotate90,
            3 => Rotation::Rotate180,
            4 => Rotation::Rotate270,
            _ => Rotation::None,
        }
    }

    /// Whether the picture's width and height trade places when it is turned.
    pub fn swaps_axes(self) -> bool {
        matches!(self, Rotation::Rotate90 | Rotation::Rotate270)
    }

    /// The size of the upright picture made from a texture of `width` x `height`.
    pub fn upright_size(self, width: u32, height: u32) -> (u32, u32) {
        if self.swaps_axes() {
            (height, width)
        } else {
            (width, height)
        }
    }

    /// The value of `D3D11_VIDEO_PROCESSOR_ROTATION` that turns the picture the same way
    /// (identity = 0, 90 = 1, 180 = 2, 270 = 3, all clockwise).
    pub fn video_processor_value(self) -> i32 {
        match self {
            Rotation::None => 0,
            Rotation::Rotate90 => 1,
            Rotation::Rotate180 => 2,
            Rotation::Rotate270 => 3,
        }
    }

    /// Where a point of the upright picture (`x`, `y`, counted from its top left, in the continuous
    /// coordinates of pixel corners) lies on the texture Windows hands over, whose upright size is
    /// `upright_w` x `upright_h`. This is what the mouse cursor needs: Windows gives its position
    /// in the upright screen's coordinates.
    pub fn to_texture(self, x: f32, y: f32, upright_w: f32, upright_h: f32) -> (f32, f32) {
        match self {
            Rotation::None => (x, y),
            Rotation::Rotate90 => (y, upright_w - x),
            Rotation::Rotate180 => (upright_w - x, upright_h - y),
            Rotation::Rotate270 => (upright_h - y, x),
        }
    }
}

/// A rectangle in whole pixels (`right` and `bottom` are one past the last pixel).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

impl Rect {
    pub fn width(&self) -> u32 {
        self.right - self.left
    }

    pub fn height(&self) -> u32 {
        self.bottom - self.top
    }
}

/// Where a `src_w` x `src_h` picture goes inside an `out_w` x `out_h` one so the whole of it shows
/// at its own shape (black bars fill the rest). All edges are even, as 4:2:0 video needs. A picture
/// of the same shape fills the whole thing.
pub fn fit(src_w: u32, src_h: u32, out_w: u32, out_h: u32) -> Rect {
    let whole = Rect { left: 0, top: 0, right: out_w, bottom: out_h };
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        return whole;
    }
    // Compare the shapes without dividing: src_w / src_h against out_w / out_h.
    let (a, b) = (u64::from(src_w) * u64::from(out_h), u64::from(out_w) * u64::from(src_h));
    if a == b {
        return whole;
    }
    let even = |n: u64| ((n / 2) * 2).max(2) as u32;
    let (w, h) = if a > b {
        // Wider than the frame: full width, bars above and below.
        (out_w, even((u64::from(out_w) * u64::from(src_h) + u64::from(src_w) / 2) / u64::from(src_w)).min(out_h))
    } else {
        (even((u64::from(out_h) * u64::from(src_w) + u64::from(src_h) / 2) / u64::from(src_h)).min(out_w), out_h)
    };
    let left = ((out_w - w) / 2) / 2 * 2;
    let top = ((out_h - h) / 2) / 2 * 2;
    Rect { left, top, right: left + w, bottom: top + h }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_numbers_dxgi_uses() {
        assert_eq!(Rotation::from_dxgi(1), Rotation::None);
        assert_eq!(Rotation::from_dxgi(2), Rotation::Rotate90);
        assert_eq!(Rotation::from_dxgi(3), Rotation::Rotate180);
        assert_eq!(Rotation::from_dxgi(4), Rotation::Rotate270);
        // 0 is "unspecified", and anything else is nonsense: both mean not turned.
        assert_eq!(Rotation::from_dxgi(0), Rotation::None);
        assert_eq!(Rotation::from_dxgi(9), Rotation::None);
        assert_eq!(Rotation::from_dxgi(-1), Rotation::None);
    }

    #[test]
    fn a_quarter_turn_swaps_the_sides() {
        assert_eq!(Rotation::None.upright_size(2560, 1440), (2560, 1440));
        assert_eq!(Rotation::Rotate180.upright_size(2560, 1440), (2560, 1440));
        assert_eq!(Rotation::Rotate90.upright_size(2560, 1440), (1440, 2560));
        assert_eq!(Rotation::Rotate270.upright_size(2560, 1440), (1440, 2560));
        assert!(Rotation::Rotate90.swaps_axes() && Rotation::Rotate270.swaps_axes());
        assert!(!Rotation::None.swaps_axes() && !Rotation::Rotate180.swaps_axes());
    }

    #[test]
    fn the_video_processor_is_told_the_same_turn() {
        let values: Vec<i32> =
            [Rotation::None, Rotation::Rotate90, Rotation::Rotate180, Rotation::Rotate270].iter().map(|r| r.video_processor_value()).collect();
        assert_eq!(values, vec![0, 1, 2, 3]);
    }

    #[test]
    fn the_cursor_lands_where_the_turned_texture_shows_it() {
        // An upright 1440 x 2560 screen (a monitor turned on its side), seen as a 2560 x 1440 texture.
        let (w, h) = (1440.0, 2560.0);
        // The upright top left is the texture's bottom left after a quarter turn the one way...
        assert_eq!(Rotation::Rotate90.to_texture(0.0, 0.0, w, h), (0.0, w));
        // ...and the upright top right is the texture's top left.
        assert_eq!(Rotation::Rotate90.to_texture(w, 0.0, w, h), (0.0, 0.0));
        assert_eq!(Rotation::Rotate90.to_texture(w, h, w, h), (h, 0.0));
        assert_eq!(Rotation::Rotate270.to_texture(0.0, 0.0, w, h), (h, 0.0));
        assert_eq!(Rotation::Rotate270.to_texture(w, h, w, h), (0.0, w));
        assert_eq!(Rotation::Rotate180.to_texture(10.0, 20.0, w, h), (w - 10.0, h - 20.0));
        assert_eq!(Rotation::None.to_texture(10.0, 20.0, w, h), (10.0, 20.0));
    }

    #[test]
    fn turning_the_cursor_there_and_back_gives_the_same_point() {
        // The inverse of Rotate90 is Rotate270 on the texture's own (swapped) size.
        let (w, h) = (1000.0, 600.0);
        let (tx, ty) = Rotation::Rotate90.to_texture(123.0, 45.0, w, h);
        // The texture is h wide and w tall; turning back the other way is Rotate270 with those sides.
        let (x, y) = Rotation::Rotate270.to_texture(tx, ty, h, w);
        assert_eq!((x, y), (123.0, 45.0));
    }

    #[test]
    fn the_same_shape_fills_the_frame() {
        let whole = Rect { left: 0, top: 0, right: 1920, bottom: 1080 };
        assert_eq!(fit(2560, 1440, 1920, 1080), whole);
        assert_eq!(fit(1920, 1080, 1920, 1080), whole);
        assert_eq!(fit(1280, 720, 1920, 1080), whole);
    }

    #[test]
    fn a_wider_picture_gets_bars_above_and_below() {
        // 21:9 into 16:9.
        let r = fit(3440, 1440, 1920, 1080);
        assert_eq!((r.left, r.right), (0, 1920));
        assert_eq!(r.height(), 804);
        assert_eq!(r.top, 138);
        assert_eq!(r.bottom, r.top + 804);
    }

    #[test]
    fn a_taller_picture_gets_bars_left_and_right() {
        // A portrait screen into a landscape frame.
        let r = fit(1440, 2560, 1920, 1080);
        assert_eq!((r.top, r.bottom), (0, 1080));
        assert_eq!(r.width(), 608);
        assert_eq!(r.left, 656);
    }

    #[test]
    fn every_edge_is_even_and_inside_the_frame() {
        for (sw, sh) in [(1366, 768), (1001, 777), (3000, 100), (100, 3000), (1, 1), (2, 5)] {
            for (ow, oh) in [(1920, 1080), (1280, 720), (1000, 1000), (2, 2)] {
                let r = fit(sw, sh, ow, oh);
                assert!(r.left.is_multiple_of(2) && r.top.is_multiple_of(2), "{sw}x{sh} in {ow}x{oh}: {r:?}");
                assert!(r.right.is_multiple_of(2) && r.bottom.is_multiple_of(2) || r.right == ow && r.bottom == oh, "{sw}x{sh} in {ow}x{oh}: {r:?}");
                assert!(r.right <= ow && r.bottom <= oh && r.width() >= 2 && r.height() >= 2, "{sw}x{sh} in {ow}x{oh}: {r:?}");
            }
        }
    }

    #[test]
    fn nonsense_sizes_fill_the_frame() {
        assert_eq!(fit(0, 0, 1920, 1080), Rect { left: 0, top: 0, right: 1920, bottom: 1080 });
    }
}
