//! Capturing a screen with DXGI Desktop Duplication, entirely on the graphics card.
//!
//! Windows hands over the desktop as a texture and the mouse cursor separately (as a position and
//! a little picture), so the cursor is drawn onto a copy of the frame here, with a tiny shader, the
//! way the cursor is drawn on screen: normal cursors blend in, and the black-and-white "inverting"
//! ones (the text I-beam) are done with the same two-step mask trick Windows uses. Nothing is read
//! back to the processor.
//!
//! Windows hands the screen over as the card scans it out. A screen turned on its side comes as a
//! turned picture, and the cursor's position is given for the screen as the person sees it, so the
//! cursor is placed (and turned) into the picture Windows gave; the video processor then turns the
//! whole picture upright (see `convert.rs`). An HDR screen is asked for as an ordinary 8-bit
//! picture, which Windows makes from the HDR one. When the screen changes (a new resolution, a turn,
//! HDR switched) the capture starts again and the new picture's shape is reported through
//! [`Capturer::generation`].

use crate::error::{Context, Error, Result};
use crate::gpu::Gpu;
use crate::log::debug;
use crate::orient::Rotation;
use windows::core::{s, Interface};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{ID3DBlob, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::*;

const SHADER: &str = r#"
cbuffer Where : register(b0) { float4 origin_and_x; float4 y_axis; };
Texture2D picture : register(t0);
SamplerState point_sampler : register(s0);
struct Out { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
Out vs(uint id : SV_VertexID) {
    float2 c = float2(id & 1, id >> 1);
    Out o;
    o.pos = float4(origin_and_x.xy + c.x * origin_and_x.zw + c.y * y_axis.xy, 0, 1);
    o.uv = c;
    return o;
}
float4 ps(Out i) : SV_Target { return picture.Sample(point_sampler, i.uv); }
"#;

/// What the mouse cursor looks like right now.
struct CursorShape {
    width: u32,
    height: u32,
    /// Normal pictures (with their own transparency).
    color: Option<ID3D11ShaderResourceView>,
    /// The two masks of a black-and-white cursor.
    keep: Option<ID3D11ShaderResourceView>,
    flip: Option<ID3D11ShaderResourceView>,
}

struct CursorDrawing {
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    constants: ID3D11Buffer,
    sampler: ID3D11SamplerState,
    raster: ID3D11RasterizerState,
    alpha: ID3D11BlendState,
    and: ID3D11BlendState,
    xor: ID3D11BlendState,
}

fn compile(entry: windows::core::PCSTR, target: windows::core::PCSTR) -> Result<ID3DBlob> {
    let mut code: Option<ID3DBlob> = None;
    // SAFETY: the source string outlives the call; out-pointers are valid.
    unsafe {
        D3DCompile(SHADER.as_ptr() as *const _, SHADER.len(), None, None, None, entry, target, 0, 0, &mut code, None)
            .context("Couldn't prepare the cursor drawing")?;
    }
    code.ok_or_else(|| Error::new("Couldn't prepare the cursor drawing."))
}

fn blob_bytes(blob: &ID3DBlob) -> &[u8] {
    // SAFETY: the blob owns `GetBufferSize` bytes at `GetBufferPointer` for as long as it lives.
    unsafe { std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize()) }
}

fn blend_state(gpu: &Gpu, source: D3D11_BLEND, dest: D3D11_BLEND) -> Result<ID3D11BlendState> {
    let mut desc = D3D11_BLEND_DESC::default();
    desc.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
        BlendEnable: true.into(),
        SrcBlend: source,
        DestBlend: dest,
        BlendOp: D3D11_BLEND_OP_ADD,
        SrcBlendAlpha: D3D11_BLEND_ONE,
        DestBlendAlpha: D3D11_BLEND_ZERO,
        BlendOpAlpha: D3D11_BLEND_OP_ADD,
        RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
    };
    let mut state = None;
    // SAFETY: valid descriptor and out-pointer.
    unsafe { gpu.device.CreateBlendState(&desc, Some(&mut state))? };
    state.ok_or_else(|| Error::new("Couldn't prepare the cursor drawing."))
}

impl CursorDrawing {
    fn new(gpu: &Gpu) -> Result<CursorDrawing> {
        let vs_code = compile(s!("vs"), s!("vs_4_0"))?;
        let ps_code = compile(s!("ps"), s!("ps_4_0"))?;
        // SAFETY: all descriptors are valid for the calls; out-pointers are filled before use.
        unsafe {
            let mut vs = None;
            gpu.device.CreateVertexShader(blob_bytes(&vs_code), None, Some(&mut vs))?;
            let mut ps = None;
            gpu.device.CreatePixelShader(blob_bytes(&ps_code), None, Some(&mut ps))?;
            let mut constants = None;
            gpu.device.CreateBuffer(
                &D3D11_BUFFER_DESC { ByteWidth: 32, Usage: D3D11_USAGE_DEFAULT, BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32, ..Default::default() },
                None,
                Some(&mut constants),
            )?;
            let mut sampler = None;
            gpu.device.CreateSamplerState(
                &D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_POINT,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    ComparisonFunc: D3D11_COMPARISON_NEVER,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                },
                Some(&mut sampler),
            )?;
            let mut raster = None;
            gpu.device.CreateRasterizerState(
                &D3D11_RASTERIZER_DESC { FillMode: D3D11_FILL_SOLID, CullMode: D3D11_CULL_NONE, DepthClipEnable: true.into(), ..Default::default() },
                Some(&mut raster),
            )?;
            let missing = || Error::new("Couldn't prepare the cursor drawing.");
            Ok(CursorDrawing {
                vs: vs.ok_or_else(missing)?,
                ps: ps.ok_or_else(missing)?,
                constants: constants.ok_or_else(missing)?,
                sampler: sampler.ok_or_else(missing)?,
                raster: raster.ok_or_else(missing)?,
                // Normal: the picture over the screen by its own transparency.
                alpha: blend_state(gpu, D3D11_BLEND_SRC_ALPHA, D3D11_BLEND_INV_SRC_ALPHA)?,
                // Black-and-white cursors: first keep the screen where the mask says (screen * mask)...
                and: blend_state(gpu, D3D11_BLEND_ZERO, D3D11_BLEND_SRC_COLOR)?,
                // ...then turn it inside out where the second mask says (screen XOR mask).
                xor: blend_state(gpu, D3D11_BLEND_INV_DEST_COLOR, D3D11_BLEND_INV_SRC_COLOR)?,
            })
        }
    }
}

fn texture_from_bgra(gpu: &Gpu, width: u32, height: u32, pixels: &[u8]) -> Result<ID3D11ShaderResourceView> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_IMMUTABLE,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        ..Default::default()
    };
    let data = D3D11_SUBRESOURCE_DATA { pSysMem: pixels.as_ptr() as *const _, SysMemPitch: width * 4, SysMemSlicePitch: 0 };
    // SAFETY: `pixels` holds width*height*4 bytes and is copied by the call.
    unsafe {
        let mut texture = None;
        gpu.device.CreateTexture2D(&desc, Some(&data), Some(&mut texture))?;
        let texture = texture.ok_or_else(|| Error::new("Couldn't make the cursor picture."))?;
        let mut view = None;
        gpu.device.CreateShaderResourceView(&texture, None, Some(&mut view))?;
        view.ok_or_else(|| Error::new("Couldn't make the cursor picture."))
    }
}

/// The cursor's picture as Windows gave it, turned into textures. `bytes` is the raw shape buffer.
fn build_shape(gpu: &Gpu, info: &DXGI_OUTDUPL_POINTER_SHAPE_INFO, bytes: &[u8]) -> Result<CursorShape> {
    let (w, pitch) = (info.Width as usize, info.Pitch as usize);
    match info.Type as i32 {
        t if t == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 => {
            // A black-and-white cursor is two stacked 1-bit masks: AND on top, XOR below.
            let h = (info.Height / 2) as usize;
            let bit = |row: usize, x: usize| bytes.get(row * pitch + x / 8).is_some_and(|b| b & (0x80 >> (x % 8)) != 0);
            let mut keep = Vec::with_capacity(w * h * 4);
            let mut flip = Vec::with_capacity(w * h * 4);
            for y in 0..h {
                for x in 0..w {
                    let k = if bit(y, x) { 255 } else { 0 };
                    let f = if bit(y + h, x) { 255 } else { 0 };
                    keep.extend_from_slice(&[k, k, k, 255]);
                    flip.extend_from_slice(&[f, f, f, 255]);
                }
            }
            Ok(CursorShape {
                width: w as u32,
                height: h as u32,
                color: None,
                keep: Some(texture_from_bgra(gpu, w as u32, h as u32, &keep)?),
                flip: Some(texture_from_bgra(gpu, w as u32, h as u32, &flip)?),
            })
        }
        t if t == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 || t == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0 => {
            let h = info.Height as usize;
            let masked = t == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0;
            let mut pixels = Vec::with_capacity(w * h * 4);
            for y in 0..h {
                for x in 0..w {
                    let at = y * pitch + x * 4;
                    let px = bytes.get(at..at + 4).unwrap_or(&[0, 0, 0, 0]);
                    if masked {
                        // The fourth byte is a mask here: 0 means "show this colour", 0xFF "invert the screen".
                        // The inverting kind is left out; the colour kind is drawn solid.
                        pixels.extend_from_slice(&[px[0], px[1], px[2], if px[3] == 0 { 255 } else { 0 }]);
                    } else {
                        pixels.extend_from_slice(px);
                    }
                }
            }
            Ok(CursorShape { width: w as u32, height: h as u32, color: Some(texture_from_bgra(gpu, w as u32, h as u32, &pixels)?), keep: None, flip: None })
        }
        _ => Err(Error::new("Unknown cursor type.")),
    }
}

fn make_texture(gpu: &Gpu, width: u32, height: u32, bind: u32) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind,
        ..Default::default()
    };
    let mut texture = None;
    // SAFETY: valid descriptor and out-pointer.
    unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut texture)).context("Couldn't make room for the screen on the graphics card")? };
    texture.ok_or_else(|| Error::new("Couldn't make room for the screen on the graphics card."))
}

fn duplicate_error(e: windows::core::Error) -> Error {
    if e.code() == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE {
        Error::new("Windows is already sharing this screen with too many programs. Close other screen recorders and try again.")
    } else if e.code() == DXGI_ERROR_UNSUPPORTED {
        Error::new("This screen can't be captured (it may be on a different graphics card than the one doing the work).")
    } else if e.code() == DXGI_ERROR_ACCESS_DENIED || e.code() == windows::Win32::Foundation::E_ACCESSDENIED {
        Error::new("Windows won't share the screen right now (a lock screen or a permission prompt may be up).")
    } else {
        Error::from(e)
    }
}

/// What a duplication says about the pictures it will hand over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DupInfo {
    width: u32,
    height: u32,
    rotation: Rotation,
}

/// Starts duplicating the output. An HDR screen is asked for as an 8-bit BGRA picture, which makes
/// Windows hand over its SDR version (the way FFmpeg's `ddagrab` does when told to). The output is
/// looked up again each time, because after a mode change the old object may be stale.
fn duplicate(adapter: &IDXGIAdapter1, on_adapter: u32, gpu: &Gpu) -> Result<(IDXGIOutputDuplication, DupInfo)> {
    // SAFETY: plain DXGI calls on live objects; the device outlives the duplication object.
    unsafe {
        let output = adapter.EnumOutputs(on_adapter).context("Couldn't find the screen")?;
        let duplication = match output.cast::<IDXGIOutput5>() {
            Ok(output5) => output5.DuplicateOutput1(&gpu.device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]).map_err(duplicate_error)?,
            Err(_) => {
                debug("capture: no IDXGIOutput5 on this Windows, using the older duplication");
                let output1: IDXGIOutput1 = output.cast().context("This Windows can't capture the screen")?;
                output1.DuplicateOutput(&gpu.device).map_err(duplicate_error)?
            }
        };
        let desc = duplication.GetDesc();
        // The description names the screen's own format (an HDR screen says so even when asked for the
        // SDR picture); the format of the pictures that really arrive is checked on each one.
        let info = DupInfo { width: desc.ModeDesc.Width, height: desc.ModeDesc.Height, rotation: Rotation::from_dxgi(desc.Rotation.0) };
        debug(&format!("capture: duplicating {}x{} rotation {:?}, the screen's format is {}", info.width, info.height, info.rotation, desc.ModeDesc.Format.0));
        Ok((duplication, info))
    }
}

/// What a grab found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grab {
    /// The screen changed since the last grab.
    New,
    /// The screen is as it was (so the last picture is used again).
    Same,
}

pub struct Capturer {
    gpu: Gpu,
    adapter: IDXGIAdapter1,
    on_adapter: u32,
    duplication: Option<IDXGIOutputDuplication>,
    /// What the duplication in use says; the pictures in use change to match when its first frame arrives.
    dup: DupInfo,
    /// The size of the pictures Windows hands over (turned, for a screen on its side), and which way they are turned.
    pub width: u32,
    pub height: u32,
    pub rotation: Rotation,
    desktop: ID3D11Texture2D,
    canvas: ID3D11Texture2D,
    canvas_target: ID3D11RenderTargetView,
    have_picture: bool,
    cursor_at: POINT,
    cursor_visible: bool,
    shape: Option<CursorShape>,
    drawing: CursorDrawing,
    next_retry: std::time::Instant,
    /// How many times the capture had to be restarted (a full-screen game, a resolution change, a lock screen).
    pub restarts: u32,
    /// Counts the times the picture's size or turn changed; the converter is told again when it does.
    pub generation: u32,
}

/// Both are marked as render targets because the video processor only takes such textures as input.
const BIND: u32 = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;

impl Capturer {
    pub fn new(gpu: &Gpu, adapter: &IDXGIAdapter1, on_adapter: u32) -> Result<Capturer> {
        let (duplication, dup) = duplicate(adapter, on_adapter, gpu)?;
        let desktop = make_texture(gpu, dup.width, dup.height, BIND)?;
        let (canvas, canvas_target) = Self::make_canvas(gpu, dup.width, dup.height)?;
        Ok(Capturer {
            gpu: gpu.clone(),
            adapter: adapter.clone(),
            on_adapter,
            duplication: Some(duplication),
            dup,
            width: dup.width,
            height: dup.height,
            rotation: dup.rotation,
            desktop,
            canvas,
            canvas_target,
            have_picture: false,
            cursor_at: POINT::default(),
            cursor_visible: false,
            shape: None,
            drawing: CursorDrawing::new(gpu)?,
            next_retry: std::time::Instant::now(),
            restarts: 0,
            generation: 0,
        })
    }

    fn make_canvas(gpu: &Gpu, width: u32, height: u32) -> Result<(ID3D11Texture2D, ID3D11RenderTargetView)> {
        let canvas = make_texture(gpu, width, height, BIND)?;
        let mut target = None;
        // SAFETY: valid texture and out-pointer.
        unsafe { gpu.device.CreateRenderTargetView(&canvas, None, Some(&mut target))? };
        Ok((canvas, target.ok_or_else(|| Error::new("Couldn't prepare the screen capture."))?))
    }

    /// The screen's picture is now this shape: make room for it.
    fn reshape(&mut self, width: u32, height: u32, rotation: Rotation) -> Result<()> {
        debug(&format!("capture: the screen is now {width}x{height}, rotation {rotation:?} (was {}x{}, {:?})", self.width, self.height, self.rotation));
        self.desktop = make_texture(&self.gpu, width, height, BIND)?;
        let (canvas, target) = Self::make_canvas(&self.gpu, width, height)?;
        self.canvas = canvas;
        self.canvas_target = target;
        (self.width, self.height, self.rotation) = (width, height, rotation);
        self.generation += 1;
        Ok(())
    }

    /// How the converter should read the pictures this hands over.
    pub fn geometry(&self) -> crate::convert::Geometry {
        crate::convert::Geometry { width: self.width, height: self.height, rotation: self.rotation, kind: crate::convert::InputKind::Bgra }
    }

    fn start_duplication(&mut self) -> Result<()> {
        let (duplication, dup) = duplicate(&self.adapter, self.on_adapter, &self.gpu)?;
        self.duplication = Some(duplication);
        self.dup = dup;
        Ok(())
    }

    /// Takes the newest picture of the screen, if there is one. Never waits. When Windows takes the
    /// screen away for a moment (the lock screen, a full-screen game, a new resolution) the last
    /// picture is kept and the capture starts again as soon as it can.
    pub fn grab(&mut self) -> Result<Grab> {
        if self.duplication.is_none() {
            if std::time::Instant::now() < self.next_retry {
                return Ok(Grab::Same);
            }
            self.next_retry = std::time::Instant::now() + std::time::Duration::from_millis(250);
            if self.start_duplication().is_err() {
                return Ok(Grab::Same);
            }
            self.restarts += 1;
        }
        let duplication = self.duplication.clone().expect("started above");
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        // SAFETY: out-pointers are valid; the frame is released below before the next acquire.
        let acquired = unsafe { duplication.AcquireNextFrame(0, &mut info, &mut resource) };
        match acquired {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(Grab::Same),
            Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST || e.code() == DXGI_ERROR_INVALID_CALL => {
                self.duplication = None;
                return Ok(Grab::Same);
            }
            Err(e) => return Err(Error::from(e)),
        }
        let mut changed = false;
        let mut failure = None;
        if info.LastPresentTime != 0 {
            if let Some(texture) = resource.as_ref().and_then(|r| r.cast::<ID3D11Texture2D>().ok()) {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                // SAFETY: a plain getter on a live object.
                unsafe { texture.GetDesc(&mut desc) };
                if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
                    failure = Some(Error::new("Windows handed over this screen in a colour mode Uncbox can't read."));
                } else {
                    // The screen has another shape than the pictures in use: take the new one from this frame on.
                    if (desc.Width, desc.Height) != (self.width, self.height) || self.dup.rotation != self.rotation {
                        if let Err(e) = self.reshape(desc.Width, desc.Height, self.dup.rotation) {
                            failure = Some(e);
                        }
                    }
                    if failure.is_none() {
                        // SAFETY: both textures are the same size and format; this is a copy on the card.
                        unsafe { self.gpu.context.CopyResource(&self.desktop, &texture) };
                        self.have_picture = true;
                        changed = true;
                    }
                }
            }
        }
        if info.LastMouseUpdateTime != 0 {
            self.cursor_at = info.PointerPosition.Position;
            self.cursor_visible = info.PointerPosition.Visible.as_bool();
        }
        if info.PointerShapeBufferSize > 0 {
            self.load_shape(&duplication, info.PointerShapeBufferSize);
        }
        drop(resource);
        // SAFETY: pairs with the successful acquire.
        unsafe {
            let _ = duplication.ReleaseFrame();
        }
        if let Some(e) = failure {
            return Err(e);
        }
        Ok(if changed || (info.LastMouseUpdateTime != 0 && self.cursor_visible) { Grab::New } else { Grab::Same })
    }

    fn load_shape(&mut self, duplication: &IDXGIOutputDuplication, size: u32) {
        let mut bytes = vec![0u8; size as usize];
        let mut needed = 0u32;
        let mut info = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
        // SAFETY: the buffer is `size` bytes as the call requires.
        let got = unsafe { duplication.GetFramePointerShape(size, bytes.as_mut_ptr() as *mut _, &mut needed, &mut info) };
        if got.is_ok() {
            self.shape = build_shape(&self.gpu, &info, &bytes).ok();
        }
    }

    /// The picture to send: the screen, with the cursor on it when it is showing.
    pub fn picture(&mut self) -> &ID3D11Texture2D {
        let draw = self.have_picture && self.cursor_visible && self.shape.is_some();
        if !draw {
            return &self.desktop;
        }
        let ctx = &self.gpu.context;
        let shape = self.shape.as_ref().expect("checked above");
        let (sw, sh) = (self.width as f32, self.height as f32);
        // Where the cursor's corners are on the picture Windows gave (which is turned, for a screen on
        // its side), in the -1..1 coordinates the shader wants (y goes up).
        let (uw, uh) = self.rotation.upright_size(self.width, self.height);
        let (px, py) = (self.cursor_at.x as f32, self.cursor_at.y as f32);
        let corner = |cx: f32, cy: f32| {
            let (x, y) = self.rotation.to_texture(px + cx * shape.width as f32, py + cy * shape.height as f32, uw as f32, uh as f32);
            (x / sw * 2.0 - 1.0, 1.0 - y / sh * 2.0)
        };
        let (origin, across, down) = (corner(0.0, 0.0), corner(1.0, 0.0), corner(0.0, 1.0));
        let constants = [origin.0, origin.1, across.0 - origin.0, across.1 - origin.1, down.0 - origin.0, down.1 - origin.1, 0.0, 0.0];
        // SAFETY: standard Direct3D 11 state setting and drawing; every object used is alive for the call.
        unsafe {
            ctx.CopyResource(&self.canvas, &self.desktop);
            ctx.UpdateSubresource(&self.drawing.constants, 0, None, constants.as_ptr() as *const _, 0, 0);
            ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
            ctx.VSSetShader(&self.drawing.vs, None);
            ctx.PSSetShader(&self.drawing.ps, None);
            ctx.VSSetConstantBuffers(0, Some(&[Some(self.drawing.constants.clone())]));
            ctx.PSSetSamplers(0, Some(&[Some(self.drawing.sampler.clone())]));
            ctx.RSSetState(&self.drawing.raster);
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT { TopLeftX: 0.0, TopLeftY: 0.0, Width: sw, Height: sh, MinDepth: 0.0, MaxDepth: 1.0 }]));
            ctx.OMSetRenderTargets(Some(&[Some(self.canvas_target.clone())]), None);
            let pass = |view: &Option<ID3D11ShaderResourceView>, blend: &ID3D11BlendState| {
                if let Some(view) = view {
                    ctx.PSSetShaderResources(0, Some(&[Some(view.clone())]));
                    ctx.OMSetBlendState(blend, None, 0xFFFF_FFFF);
                    ctx.Draw(4, 0);
                }
            };
            pass(&shape.color, &self.drawing.alpha);
            pass(&shape.keep, &self.drawing.and);
            pass(&shape.flip, &self.drawing.xor);
            // Let go of the canvas so the video processor can read it.
            ctx.OMSetRenderTargets(None, None);
            ctx.PSSetShaderResources(0, Some(&[None]));
        }
        &self.canvas
    }

    /// Waits up to `limit` for the first picture of the screen (a screen that never changes may not send one at once).
    pub fn wait_for_picture(&mut self, limit: std::time::Duration) -> Result<()> {
        let deadline = std::time::Instant::now() + limit;
        while !self.have_picture && std::time::Instant::now() < deadline {
            self.grab()?;
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Ok(())
    }
}
