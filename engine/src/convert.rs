//! Turning the picture (the captured BGRA screen, or an NV12 picture from a file) into the NV12
//! picture the encoder takes: converting the colours, turning it upright, and scaling it to the
//! size being sent, all with the Direct3D 11 video processor, which is one fixed-function pass on
//! the graphics card. This is the step the FFmpeg setup could not do on the card (its `scale_d3d11`
//! filter can't take the screen capture's frames), so it did it on the processor and paid for it in
//! frame rate.
//!
//! The size that is sent never changes during a stream. If the source does (a new screen
//! resolution, a screen turned on its side), the picture is fitted into the same frame at its own
//! shape, with black bars if the shape differs.
//!
//! The converted pictures come from a pool. A picture is out of the pool from when it is made
//! until the encoder says it is done with it ([`PictureReleaser::release`]), which for an encoder
//! that looks ahead is a couple of dozen pictures later. If the pool is empty the picture is
//! skipped, never made over one still in use.

use crate::error::{Context, Error, Result};
use crate::gpu::Gpu;
use crate::orient::{fit, Rect, Rotation};
use std::sync::{Arc, Mutex};
use windows::core::Interface;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};

/// `D3D11_VIDEO_PROCESSOR_COLOR_SPACE` as one number: usage (bit 0), RGB range (bit 1, 0 = full),
/// YCbCr matrix (bit 2, 1 = BT.709), xvYCC (bit 3), nominal range (bits 4-5, 1 = 16-235).
const SCREEN_COLORS: u32 = 0;
const VIDEO_COLORS: u32 = (1 << 2) | (1 << 4);

/// What the picture going in is made of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    /// The screen: 8-bit BGRA, full range.
    Bgra,
    /// Video: NV12, BT.709, limited range (a Y4M file).
    Nv12,
}

/// How the pictures going in are laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub rotation: Rotation,
    pub kind: InputKind,
}

/// A converted picture: the texture, and the name to hand back when the encoder is finished with it.
pub struct Picture {
    pub token: usize,
    pub texture: ID3D11Texture2D,
}

/// Gives pictures back to the pool; cheap to clone, usable from any thread.
#[derive(Clone)]
pub struct PictureReleaser(Arc<Mutex<Vec<usize>>>);

impl PictureReleaser {
    pub fn release(&self, token: usize) {
        self.0.lock().expect("picture pool lock").push(token);
    }
}

type Outputs = Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>;

pub struct Converter {
    gpu: Gpu,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    fps: u32,
    pub out_width: u32,
    pub out_height: u32,
    textures: Vec<ID3D11Texture2D>,
    free: Arc<Mutex<Vec<usize>>>,
    state: Option<State>,
    /// Whether the card's video processor can turn the picture.
    can_rotate: bool,
}

/// What depends on the source's shape: the processor, and the views of the pool's textures it writes to.
struct State {
    geometry: Geometry,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    outputs: Outputs,
    inputs: Vec<(usize, ID3D11VideoProcessorInputView)>,
}

fn rect(r: Rect) -> RECT {
    RECT { left: r.left as i32, top: r.top as i32, right: r.right as i32, bottom: r.bottom as i32 }
}

impl Converter {
    /// `pool` is how many output pictures there are in all: enough that the encoder's look-ahead and
    /// the pictures waiting in line still leave one to make the next in.
    pub fn new(gpu: &Gpu, out_w: u32, out_h: u32, fps: u32, pool: usize) -> Result<Converter> {
        let video_device: ID3D11VideoDevice = gpu.device.cast().context("This graphics card can't convert video")?;
        let video_context: ID3D11VideoContext = gpu.context.cast().context("This graphics card can't convert video")?;
        let mut textures = Vec::with_capacity(pool);
        for _ in 0..pool {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: out_w,
                Height: out_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                ..Default::default()
            };
            let mut texture = None;
            // SAFETY: valid descriptor and out-pointer.
            unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut texture)) }
                .context("Couldn't make room for the converted picture on the graphics card")?;
            textures.push(texture.ok_or_else(|| Error::new("Couldn't make room for the converted picture on the graphics card."))?);
        }
        // Handed out from the end, so picture 0 is the first one made.
        let free = Arc::new(Mutex::new((0..pool).rev().collect()));
        Ok(Converter { gpu: gpu.clone(), video_device, video_context, fps, out_width: out_w, out_height: out_h, textures, free, state: None, can_rotate: true })
    }

    pub fn releaser(&self) -> PictureReleaser {
        PictureReleaser(self.free.clone())
    }

    pub fn pool_size(&self) -> usize {
        self.textures.len()
    }

    /// The pool's textures, for an encoder that wants to know them up front.
    pub fn textures(&self) -> &[ID3D11Texture2D] {
        &self.textures
    }

    /// Whether the picture can be turned upright by the card. When it can't, a turned screen is sent as it is.
    pub fn can_rotate(&self) -> bool {
        self.can_rotate
    }

    /// Tells the converter the shape of the pictures that come next. Cheap when nothing changed.
    pub fn set_source(&mut self, geometry: Geometry) -> Result<()> {
        if self.state.as_ref().is_some_and(|s| s.geometry == geometry) {
            return Ok(());
        }
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: self.fps, Denominator: 1 },
            InputWidth: geometry.width,
            InputHeight: geometry.height,
            OutputFrameRate: DXGI_RATIONAL { Numerator: self.fps, Denominator: 1 },
            OutputWidth: self.out_width,
            OutputHeight: self.out_height,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        // SAFETY: Direct3D 11 video calls with valid descriptors and out-pointers.
        unsafe {
            let enumerator = self.video_device.CreateVideoProcessorEnumerator(&content).context("This graphics card can't scale video")?;
            let processor = self.video_device.CreateVideoProcessor(&enumerator, 0).context("This graphics card can't scale video")?;
            let mut caps = D3D11_VIDEO_PROCESSOR_CAPS::default();
            enumerator.GetVideoProcessorCaps(&mut caps)?;
            self.can_rotate = caps.FeatureCaps & D3D11_VIDEO_PROCESSOR_FEATURE_CAPS_ROTATION.0 as u32 != 0;
            let rotation = if self.can_rotate { geometry.rotation } else { Rotation::None };

            let (upright_w, upright_h) = rotation.upright_size(geometry.width, geometry.height);
            let whole_source = RECT { left: 0, top: 0, right: geometry.width as i32, bottom: geometry.height as i32 };
            let whole_output = RECT { left: 0, top: 0, right: self.out_width as i32, bottom: self.out_height as i32 };
            let dest = rect(fit(upright_w, upright_h, self.out_width, self.out_height));
            let color_in = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: if geometry.kind == InputKind::Bgra { SCREEN_COLORS } else { VIDEO_COLORS } };
            let color_out = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: VIDEO_COLORS };
            // Convert, turn and scale only: no driver clean-up (noise reduction, sharpening) on a desktop.
            self.video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            self.video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &color_in);
            self.video_context.VideoProcessorSetOutputColorSpace(&processor, &color_out);
            self.video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&whole_source));
            self.video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&dest));
            self.video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&whole_output));
            self.video_context.VideoProcessorSetStreamRotation(
                &processor,
                0,
                rotation != Rotation::None,
                D3D11_VIDEO_PROCESSOR_ROTATION(rotation.video_processor_value()),
            );
            // Black bars where the picture doesn't reach: legal black for limited-range video (16, 128,
            // 128). Black given as RGB came out as 0 on the NVIDIA card, which is below legal black.
            let black = D3D11_VIDEO_COLOR {
                Anonymous: D3D11_VIDEO_COLOR_0 { YCbCr: D3D11_VIDEO_COLOR_YCbCrA { Y: 16.0 / 255.0, Cb: 128.0 / 255.0, Cr: 128.0 / 255.0, A: 1.0 } },
            };
            self.video_context.VideoProcessorSetOutputBackgroundColor(&processor, true, &black);

            let mut outputs = Vec::with_capacity(self.textures.len());
            for texture in &self.textures {
                let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
                };
                let mut view = None;
                self.video_device.CreateVideoProcessorOutputView(texture, &enumerator, &view_desc, Some(&mut view))?;
                outputs.push((texture.clone(), view.ok_or_else(|| Error::new("Couldn't prepare the converted picture."))?));
            }
            self.state = Some(State { geometry, enumerator, processor, outputs, inputs: Vec::new() });
        }
        Ok(())
    }

    fn input_view(&mut self, texture: &ID3D11Texture2D) -> Result<ID3D11VideoProcessorInputView> {
        let video_device = self.video_device.clone();
        let state = self.state.as_mut().ok_or_else(|| Error::new("The converter wasn't told what it is converting."))?;
        let key = texture.as_raw() as usize;
        if let Some((_, view)) = state.inputs.iter().find(|(k, _)| *k == key) {
            return Ok(view.clone());
        }
        let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
        };
        let mut view = None;
        // SAFETY: valid texture, descriptor and out-pointer.
        unsafe {
            video_device
                .CreateVideoProcessorInputView(texture, &state.enumerator, &desc, Some(&mut view))
                .context("The graphics card can't read the picture for conversion")?
        };
        let view = view.ok_or_else(|| Error::new("Couldn't prepare the picture for conversion."))?;
        state.inputs.push((key, view.clone()));
        Ok(view)
    }

    /// Whether the current source already is what the encoder takes (NV12, the size being sent, not
    /// turned), so converting it is a plain copy. The video processor would convert even then, and
    /// its arithmetic is not exact: a copy keeps every value as the file had it.
    fn is_already_encoder_ready(&self) -> bool {
        self.state.as_ref().is_some_and(|s| {
            let g = s.geometry;
            g.kind == InputKind::Nv12 && g.rotation == Rotation::None && g.width == self.out_width && g.height == self.out_height
        })
    }

    /// Converts `source` into a picture from the pool and returns it, or `None` if every picture is still with the encoder.
    pub fn convert(&mut self, source: &ID3D11Texture2D) -> Result<Option<Picture>> {
        let Some(token) = self.free.lock().expect("picture pool lock").pop() else { return Ok(None) };
        if self.is_already_encoder_ready() {
            let texture = self.textures[token].clone();
            // SAFETY: both are NV12 textures of the same size on this device; this is a copy on the card.
            unsafe {
                self.gpu.context.CopyResource(&texture, source);
                self.gpu.context.Flush();
            }
            return Ok(Some(Picture { token, texture }));
        }
        let input = match self.input_view(source) {
            Ok(v) => v,
            Err(e) => {
                self.free.lock().expect("picture pool lock").push(token);
                return Err(e);
            }
        };
        let state = self.state.as_ref().expect("checked by input_view");
        let (texture, output) = state.outputs[token].clone();
        let stream = D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: std::mem::ManuallyDrop::new(Some(input)), ..Default::default() };
        // SAFETY: the stream holds a reference that is released below; everything else is alive.
        let result = unsafe { self.video_context.VideoProcessorBlt(&state.processor, &output, 0, std::slice::from_ref(&stream)) };
        let mut stream = stream;
        // SAFETY: the one reference put in above, taken back out so it is released.
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        if let Err(e) = result {
            self.free.lock().expect("picture pool lock").push(token);
            return Err(Error::from(e)).context("The graphics card couldn't convert the picture");
        }
        // The encoder reads the texture from its own thread: make sure the work that wrote it has been sent.
        // SAFETY: a plain call on the shared context.
        unsafe { self.gpu.context.Flush() };
        Ok(Some(Picture { token, texture }))
    }
}
