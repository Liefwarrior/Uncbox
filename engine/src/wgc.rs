//! One window's picture with Windows.Graphics.Capture, the way OBS's "Window Capture (Windows 10)"
//! takes it: Windows' compositor hands over each frame the window draws as a texture on the card,
//! even while other windows (a full-screen game) cover it. Nothing is read back to the processor.
//!
//! Stealth mode captures two windows this way: the Uncbox dashboard, which runs behind the game, and
//! the game itself (see `scene.rs` and `source.rs`). Each capture keeps its own copy of the newest
//! frame, so a window that stops drawing (minimized, or simply still) keeps its last picture.
//!
//! Frames are asked for no more often than the stream sends them (`MinUpdateInterval`, Windows 11
//! 24H2 and later), so a game running at 240 fps costs the compositor 60 copies a second, not 240.
//! Older Windows ignore that and the newest frame is taken each tick. The yellow border Windows draws
//! around a captured window is turned off where Windows allows it (Windows 11); on Windows 10 it shows.

use crate::error::{Context, Error, Result};
use crate::gpu::Gpu;
use crate::log::debug;
use windows::core::Interface;
use windows::Foundation::TimeSpan;
use windows::Graphics::Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::IsWindow;

/// Both are marked as render targets because the video processor only takes such textures as input.
const BIND: u32 = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;

/// Whether this Windows can capture windows (Windows 10 1903 and later).
pub fn supported() -> bool {
    GraphicsCaptureSession::IsSupported().unwrap_or(false)
}

fn hwnd(handle: isize) -> HWND {
    HWND(handle as *mut core::ffi::c_void)
}

/// Whether the window is still there.
pub fn window_exists(handle: isize) -> bool {
    // SAFETY: IsWindow takes any value and only says whether it names a window.
    unsafe { IsWindow(Some(hwnd(handle))).as_bool() }
}

fn copy_texture(gpu: &Gpu, width: u32, height: u32) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: BIND,
        ..Default::default()
    };
    let mut texture = None;
    // SAFETY: valid descriptor and out-pointer.
    unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut texture)) }.context("Couldn't make room for the window's picture on the graphics card")?;
    texture.ok_or_else(|| Error::new("Couldn't make room for the window's picture on the graphics card."))
}

/// A live capture of one window.
pub struct WindowCapture {
    gpu: Gpu,
    /// The window's handle, as the page and the app know it.
    pub handle: isize,
    device: IDirect3DDevice,
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    /// The size of the pool's buffers (what the window was when they were made).
    pool_size: SizeInt32,
    /// The newest frame, copied out of the pool so the pool can go on.
    picture: Option<ID3D11Texture2D>,
    pub width: u32,
    pub height: u32,
    cursor: bool,
}

impl WindowCapture {
    /// Starts capturing the window. `cursor` draws the mouse pointer when it is over the window;
    /// `fps` is the most frames a second worth taking.
    pub fn new(gpu: &Gpu, handle: isize, cursor: bool, fps: u32) -> Result<WindowCapture> {
        if !supported() {
            return Err(Error::new("This Windows can't capture a window (it needs Windows 10 version 1903 or later)."));
        }
        if !window_exists(handle) {
            return Err(Error::new("The window to capture has closed."));
        }
        // SAFETY: interop calls on live objects; the device outlives the capture (it holds a reference).
        unsafe {
            let dxgi: IDXGIDevice = gpu.device.cast().context("Couldn't capture the window")?;
            let device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).context("Couldn't capture the window")?.cast()?;
            let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().context("This Windows can't capture a window")?;
            let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd(handle)).context("Windows won't capture that window")?;
            let size = item.Size().context("Couldn't capture the window")?;
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
                .context("Couldn't capture the window")?;
            let session = pool.CreateCaptureSession(&item).context("Couldn't capture the window")?;
            // Each of these is newer than window capture itself: older Windows say no, which is fine.
            let _ = session.SetIsCursorCaptureEnabled(cursor);
            let _ = session.SetIsBorderRequired(false);
            // A little under the stream's frame time, so a frame drawn just after a tick still arrives for the next.
            let _ = session.SetMinUpdateInterval(TimeSpan { Duration: (10_000_000 / i64::from(fps.max(1))) * 85 / 100 });
            session.StartCapture().context("Couldn't start capturing the window")?;
            debug(&format!("window capture: started on window {handle} ({}x{}, pointer {})", size.Width, size.Height, if cursor { "on" } else { "off" }));
            Ok(WindowCapture { gpu: gpu.clone(), handle, device, _item: item, pool, session, pool_size: size, picture: None, width: 0, height: 0, cursor })
        }
    }

    /// Draws the mouse pointer over the window, or stops.
    pub fn set_cursor(&mut self, cursor: bool) {
        if cursor != self.cursor {
            self.cursor = cursor;
            let _ = self.session.SetIsCursorCaptureEnabled(cursor);
        }
    }

    /// Takes the newest frame the window has drawn, if there is one. Never waits. `true` when the
    /// picture changed.
    pub fn grab(&mut self) -> Result<bool> {
        // Only the newest matters: older ones are handed straight back.
        let mut newest: Option<Direct3D11CaptureFrame> = None;
        while let Ok(frame) = self.pool.TryGetNextFrame() {
            if let Some(old) = newest.replace(frame) {
                let _ = old.Close();
            }
        }
        let Some(frame) = newest else { return Ok(false) };
        let result = self.take(&frame);
        let _ = frame.Close();
        result
    }

    fn take(&mut self, frame: &Direct3D11CaptureFrame) -> Result<bool> {
        let content = frame.ContentSize()?;
        let (w, h) = (content.Width.max(0) as u32, content.Height.max(0) as u32);
        if w < 2 || h < 2 {
            // Minimized: nothing to show, so the last picture stays.
            return Ok(false);
        }
        // The window changed size: new buffers for the frames after this one.
        if content.Width != self.pool_size.Width || content.Height != self.pool_size.Height {
            debug(&format!("window capture: window {} is now {w}x{h}", self.handle));
            self.pool.Recreate(&self.device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content)?;
            self.pool_size = content;
        }
        if self.picture.is_none() || (w, h) != (self.width, self.height) {
            self.picture = Some(copy_texture(&self.gpu, w, h)?);
            (self.width, self.height) = (w, h);
        }
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        // SAFETY: the frame's surface is a live texture on this device; the copy stays inside both
        // (the frame's buffer is at least as big as its content, the copy exactly the content).
        unsafe {
            let texture: ID3D11Texture2D = access.GetInterface()?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            let (cw, ch) = (w.min(desc.Width), h.min(desc.Height));
            let area = D3D11_BOX { left: 0, top: 0, front: 0, right: cw, bottom: ch, back: 1 };
            if let Some(picture) = &self.picture {
                self.gpu.context.CopySubresourceRegion(picture, 0, 0, 0, 0, &texture, 0, Some(&area));
            }
        }
        Ok(true)
    }

    /// The newest picture, once one has arrived.
    pub fn picture(&self) -> Option<&ID3D11Texture2D> {
        self.picture.as_ref()
    }

    /// Waits up to `limit` for the first picture (a window that never changes sends one when capture starts).
    pub fn wait_for_picture(&mut self, limit: std::time::Duration) -> Result<()> {
        let deadline = std::time::Instant::now() + limit;
        while self.picture.is_none() && std::time::Instant::now() < deadline {
            self.grab()?;
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Ok(())
    }
}

impl Drop for WindowCapture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}
