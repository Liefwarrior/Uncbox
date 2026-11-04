//! Where the pictures come from: the screen, stealth mode's scene (the dashboard window with the
//! game's window over its panel), or (for testing and tooling) a Y4M video file whose pictures are
//! uploaded to the graphics card one at a time, so they go through exactly the same convert, scale
//! and encode road as the screen does.

use crate::capture::{Capturer, Grab};
use crate::convert::{Geometry, InputKind};
use crate::error::{Context, Error, Result};
use crate::gpu::Gpu;
use crate::log::debug;
use crate::orient::{Rect, Rotation};
use crate::scene::{place_game, Placement, Scene};
use crate::wgc::{window_exists, WindowCapture};
use crate::y4m::Y4mReader;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};

/// A second picture drawn over part of the first: the game, over the dashboard's game panel.
pub struct Overlay {
    pub texture: ID3D11Texture2D,
    pub geometry: Geometry,
    /// The part of the overlay's own picture that is drawn.
    pub source: Rect,
    /// Where it goes on the picture that is sent.
    pub dest: Rect,
}

/// One picture from a source, ready for the converter.
pub struct Grabbed {
    pub texture: ID3D11Texture2D,
    pub geometry: Geometry,
    /// Drawn over `texture` (stealth mode's game), if there is one.
    pub overlay: Option<Overlay>,
    /// The picture is the same as the last one (a screen that didn't change).
    pub same: bool,
}

/// How long a game window that couldn't be captured waits before it is tried again.
const GAME_RETRY: Duration = Duration::from_secs(2);

/// Stealth mode's picture: the dashboard window, and the game's window over its game panel (see
/// `scene.rs`). Both are window captures, so neither has to be on the screen: the dashboard runs
/// behind the game, and the game is wherever the person plays it.
pub struct SceneSource {
    gpu: Gpu,
    fps: u32,
    scene: Scene,
    dashboard: WindowCapture,
    game: Option<WindowCapture>,
    /// When the game's window may be tried again after it couldn't be captured.
    game_retry: Instant,
    last_placement: Option<Placement>,
}

impl SceneSource {
    /// Starts capturing the dashboard (and the game, if the scene has one), and waits briefly for the
    /// dashboard's first picture: the stream can't start before there is something to put on it.
    pub fn new(gpu: &Gpu, scene: Scene, fps: u32) -> Result<SceneSource> {
        let mut dashboard = WindowCapture::new(gpu, scene.window, scene.cursor, fps).context("Couldn't capture the Uncbox window")?;
        dashboard.wait_for_picture(Duration::from_secs(2))?;
        if dashboard.picture().is_none() {
            return Err(Error::new("The Uncbox window sent no picture. Is it minimized?"));
        }
        let mut source = SceneSource { gpu: gpu.clone(), fps, scene, dashboard, game: None, game_retry: Instant::now(), last_placement: None };
        source.keep_game();
        Ok(source)
    }

    /// Takes a new description: the panel moved, the game changed, the pointer setting. A new
    /// dashboard window starts its capture again (and keeps the old one if that fails).
    pub fn update(&mut self, scene: Scene) {
        if scene.window != self.dashboard.handle {
            match WindowCapture::new(&self.gpu, scene.window, scene.cursor, self.fps) {
                Ok(mut capture) => {
                    let _ = capture.wait_for_picture(Duration::from_millis(500));
                    self.dashboard = capture;
                }
                Err(e) => {
                    debug(&format!("scene: kept the old dashboard window, the new one couldn't be captured: {e}"));
                    return;
                }
            }
        }
        self.dashboard.set_cursor(scene.cursor);
        if self.game.as_ref().map(|g| g.handle) != scene.game.map(|g| g.window) {
            self.game = None;
            self.game_retry = Instant::now();
        }
        self.scene = scene;
        self.keep_game();
    }

    /// The game's capture, started when the scene has a game and stopped when its window closes.
    /// A game window that can't be captured (it may be starting, or closing) is tried again now and
    /// then; the dashboard goes on alone meanwhile.
    fn keep_game(&mut self) {
        let Some(layer) = self.scene.game else {
            self.game = None;
            return;
        };
        if self.game.as_ref().is_some_and(|g| !window_exists(g.handle)) {
            debug("scene: the game's window closed");
            self.game = None;
            self.game_retry = Instant::now() + GAME_RETRY;
        }
        if self.game.is_some() || Instant::now() < self.game_retry {
            return;
        }
        // The pointer is drawn on the game where it is over it: in stealth mode that's where it is.
        match WindowCapture::new(&self.gpu, layer.window, true, self.fps) {
            Ok(capture) => self.game = Some(capture),
            Err(e) => {
                debug(&format!("scene: couldn't capture the game's window yet: {e}"));
                self.game_retry = Instant::now() + GAME_RETRY;
            }
        }
    }

    pub fn geometry(&self) -> Geometry {
        Geometry { width: self.dashboard.width, height: self.dashboard.height, rotation: Rotation::None, kind: InputKind::Bgra }
    }

    /// The newest picture of both windows, the game placed for a picture `out` big. Never waits.
    pub fn next_frame(&mut self, out: (u32, u32)) -> Result<Grabbed> {
        let dash_new = self.dashboard.grab().context("Couldn't capture the Uncbox window")?;
        self.keep_game();
        let game_new = match self.game.as_mut().map(WindowCapture::grab) {
            Some(Ok(changed)) => changed,
            Some(Err(e)) => {
                debug(&format!("scene: the game's capture stopped: {e}"));
                self.game = None;
                self.game_retry = Instant::now() + GAME_RETRY;
                false
            }
            None => false,
        };
        let texture = self.dashboard.picture().cloned().ok_or_else(|| Error::new("The Uncbox window sent no picture."))?;
        let dash = (self.dashboard.width, self.dashboard.height);
        let overlay = self.game.as_ref().and_then(|game| {
            let texture = game.picture()?.clone();
            let placement = place_game(&self.scene, dash, (game.width, game.height), out)?;
            Some(Overlay {
                texture,
                geometry: Geometry { width: game.width, height: game.height, rotation: Rotation::None, kind: InputKind::Bgra },
                source: placement.source,
                dest: placement.dest,
            })
        });
        let placement = overlay.as_ref().map(|o| Placement { source: o.source, dest: o.dest });
        let same = !dash_new && !game_new && placement == self.last_placement;
        self.last_placement = placement;
        Ok(Grabbed { texture, geometry: self.geometry(), overlay, same })
    }
}

/// A Y4M file as a source of pictures.
pub struct Y4mSource {
    gpu: Gpu,
    reader: Y4mReader<BufReader<File>>,
    staging: ID3D11Texture2D,
    picture: ID3D11Texture2D,
    nv12: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// The file's frame rate as a whole number.
    pub fps: u32,
    frames: u64,
}

fn nv12_texture(gpu: &Gpu, width: u32, height: u32, staging: bool) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: if staging { D3D11_USAGE_STAGING } else { D3D11_USAGE_DEFAULT },
        BindFlags: if staging { 0 } else { (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32 },
        CPUAccessFlags: if staging { D3D11_CPU_ACCESS_WRITE.0 as u32 } else { 0 },
        ..Default::default()
    };
    let mut texture = None;
    // SAFETY: valid descriptor and out-pointer.
    unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut texture)) }.context("Couldn't make room for the video picture on the graphics card")?;
    texture.ok_or_else(|| Error::new("Couldn't make room for the video picture on the graphics card."))
}

impl Y4mSource {
    /// Opens the file and reads its header (so a bad file is reported before anything else starts).
    pub fn open(gpu: &Gpu, path: &Path) -> Result<Y4mSource> {
        let file = File::open(path).map_err(|e| Error::new(format!("Couldn't open the Y4M video: {}", Error::from(e))))?;
        let reader = Y4mReader::new(BufReader::with_capacity(1 << 22, file))?;
        let (width, height, fps) = (reader.header.width, reader.header.height, reader.header.fps());
        Ok(Y4mSource {
            gpu: gpu.clone(),
            staging: nv12_texture(gpu, width, height, true)?,
            picture: nv12_texture(gpu, width, height, false)?,
            reader,
            nv12: Vec::new(),
            width,
            height,
            fps,
            frames: 0,
        })
    }

    pub fn geometry(&self) -> Geometry {
        Geometry { width: self.width, height: self.height, rotation: Rotation::None, kind: InputKind::Nv12 }
    }

    /// Reads the next picture and uploads it. `None` at the end of the file.
    pub fn next_picture(&mut self) -> Result<Option<&ID3D11Texture2D>> {
        if !self.reader.read_nv12(&mut self.nv12)? {
            return Ok(None);
        }
        let (w, h) = (self.width as usize, self.height as usize);
        let ctx = &self.gpu.context;
        // SAFETY: the staging texture is mapped for writing, the planes (brightness rows, then the
        // interleaved colour rows, one pitch for both) are filled from `nv12`, and it is unmapped
        // before the copy.
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(&self.staging, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped)).context("Couldn't upload a video picture to the graphics card")?;
            let pitch = mapped.RowPitch as usize;
            let base = mapped.pData as *mut u8;
            for y in 0..h {
                std::ptr::copy_nonoverlapping(self.nv12.as_ptr().add(y * w), base.add(y * pitch), w);
            }
            let colour = base.add(pitch * h);
            for y in 0..h / 2 {
                std::ptr::copy_nonoverlapping(self.nv12.as_ptr().add(w * h + y * w), colour.add(y * pitch), w);
            }
            ctx.Unmap(&self.staging, 0);
            ctx.CopyResource(&self.picture, &self.staging);
        }
        self.frames += 1;
        Ok(Some(&self.picture))
    }

    pub fn frames_read(&self) -> u64 {
        self.frames
    }
}

/// Any kind of source.
pub enum Source {
    Screen(Box<Capturer>),
    Scene(Box<SceneSource>),
    Y4m(Box<Y4mSource>),
}

impl Source {
    /// Whether the pictures arrive in real time on their own (the screen, the scene) or as fast as they are asked for.
    pub fn is_live(&self) -> bool {
        !matches!(self, Source::Y4m(_))
    }

    pub fn geometry(&self) -> Geometry {
        match self {
            Source::Screen(c) => c.geometry(),
            Source::Scene(s) => s.geometry(),
            Source::Y4m(y) => y.geometry(),
        }
    }

    /// The next picture, or `None` when the source has ended (never for the screen or the scene).
    /// `out` is the size of the picture that is sent, which is where the scene's game is placed.
    pub fn next_frame(&mut self, out: (u32, u32)) -> Result<Option<Grabbed>> {
        match self {
            Source::Screen(capturer) => {
                let same = capturer.grab().context("Couldn't capture the screen")? == Grab::Same;
                let texture = capturer.picture().clone();
                Ok(Some(Grabbed { texture, geometry: capturer.geometry(), overlay: None, same }))
            }
            Source::Scene(scene) => scene.next_frame(out).map(Some),
            Source::Y4m(y4m) => {
                let geometry = y4m.geometry();
                Ok(y4m.next_picture()?.map(|texture| Grabbed { texture: texture.clone(), geometry, overlay: None, same: false }))
            }
        }
    }

    pub fn restarts(&self) -> u32 {
        match self {
            Source::Screen(c) => c.restarts,
            Source::Scene(_) | Source::Y4m(_) => 0,
        }
    }
}
