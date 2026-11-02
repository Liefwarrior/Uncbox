//! Finding graphics cards and the screens on them, and opening Direct3D on the right one.

use crate::error::{Context, Error, Result};
use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, LUID, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_OUTPUT_DESC};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};

#[derive(Debug, Clone)]
pub struct OutputInfo {
    /// The screen number Uncbox uses: counted across all cards in the order Windows lists them,
    /// the same way FFmpeg's `ddagrab` counts (so "screen 1" means the same with either engine).
    pub index: u32,
    pub adapter: u32,
    /// Which output of its own adapter this is.
    pub on_adapter: u32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    /// 1 = not rotated, 2 = 90, 3 = 180, 4 = 270 (DXGI_MODE_ROTATION).
    pub rotation: i32,
}

#[derive(Debug, Clone)]
pub struct AdapterInfo {
    pub index: u32,
    pub name: String,
    pub vendor_id: u32,
    pub luid: LUID,
    pub outputs: Vec<OutputInfo>,
}

/// "nvidia", "amd" or "intel" for the card makers Uncbox knows; "other" for the rest.
pub fn vendor_name(vendor_id: u32) -> &'static str {
    match vendor_id {
        0x10DE => "nvidia",
        0x1002 | 0x1022 => "amd",
        0x8086 => "intel",
        _ => "other",
    }
}

fn wide_to_string(wide: &[u16]) -> String {
    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end])
}

fn is_primary(desc: &DXGI_OUTPUT_DESC) -> bool {
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    // SAFETY: `info` is a properly sized MONITORINFO and the handle came from DXGI.
    unsafe { GetMonitorInfoW(desc.Monitor, &mut info).as_bool() && info.dwFlags & 1 != 0 }
}

/// Every hardware graphics card and the screens attached to it.
pub fn enumerate() -> Result<Vec<AdapterInfo>> {
    // SAFETY: plain DXGI calls; every returned interface is owned and released by the windows crate.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().context("Couldn't look at the graphics cards")?;
        let mut adapters = Vec::new();
        let mut screen = 0u32;
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            let desc = adapter.GetDesc1()?;
            i += 1;
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let mut outputs = Vec::new();
            let mut j = 0;
            while let Ok(output) = adapter.EnumOutputs(j) {
                let od = output.GetDesc()?;
                if od.AttachedToDesktop.as_bool() {
                    let RECT { left, top, right, bottom } = od.DesktopCoordinates;
                    outputs.push(OutputInfo {
                        index: screen,
                        adapter: i - 1,
                        on_adapter: j,
                        width: (right - left).unsigned_abs(),
                        height: (bottom - top).unsigned_abs(),
                        primary: is_primary(&od),
                        rotation: od.Rotation.0,
                    });
                    screen += 1;
                }
                j += 1;
            }
            adapters.push(AdapterInfo { index: i - 1, name: wide_to_string(&desc.Description), vendor_id: desc.VendorId, luid: desc.AdapterLuid, outputs });
        }
        Ok(adapters)
    }
}

/// The adapter and output behind screen number `screen`.
pub fn find_output(adapters: &[AdapterInfo], screen: u32) -> Result<(&AdapterInfo, &OutputInfo)> {
    for adapter in adapters {
        if let Some(output) = adapter.outputs.iter().find(|o| o.index == screen) {
            return Ok((adapter, output));
        }
    }
    let count: usize = adapters.iter().map(|a| a.outputs.len()).sum();
    Err(Error::new(if count == 0 {
        "Windows shows no screen to capture.".to_string()
    } else {
        format!("There is no screen {}. This PC has {count}.", screen + 1)
    }))
}

pub fn open_adapter(index: u32) -> Result<IDXGIAdapter1> {
    // SAFETY: as above.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        Ok(factory.EnumAdapters1(index)?)
    }
}

pub fn open_output(adapter: &IDXGIAdapter1, on_adapter: u32) -> Result<IDXGIOutput> {
    // SAFETY: as above.
    unsafe { Ok(adapter.EnumOutputs(on_adapter)?) }
}

/// A Direct3D 11 device on one card, safe to use from the capture thread and Media Foundation's at once.
#[derive(Clone)]
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
}

impl Gpu {
    pub fn open(adapter: &IDXGIAdapter1) -> Result<Gpu> {
        let mut device = None;
        let mut context = None;
        let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
        // SAFETY: out-pointers are valid for the call; the adapter is a live COM object.
        unsafe {
            D3D11CreateDevice(
                adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .context("Couldn't start Direct3D on the graphics card")?;
        }
        let device = device.ok_or_else(|| Error::new("Couldn't start Direct3D on the graphics card."))?;
        let context = context.ok_or_else(|| Error::new("Couldn't start Direct3D on the graphics card."))?;
        // Media Foundation's encoder uses this device from its own threads too.
        if let Ok(multithread) = device.cast::<ID3D11Multithread>() {
            // SAFETY: a plain setter on a live object.
            unsafe {
                let _ = multithread.SetMultithreadProtected(true);
            }
        }
        Ok(Gpu { device, context })
    }
}
