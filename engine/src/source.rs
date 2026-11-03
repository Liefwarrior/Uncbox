//! Where the pictures come from: the screen, or (for testing and tooling) a Y4M video file whose
//! pictures are uploaded to the graphics card one at a time, so they go through exactly the same
//! convert, scale and encode road as the screen does.

use crate::capture::{Capturer, Grab};
use crate::convert::{Geometry, InputKind};
use crate::error::{Context, Error, Result};
use crate::gpu::Gpu;
use crate::orient::Rotation;
use crate::y4m::Y4mReader;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};

/// One picture from a source, ready for the converter.
pub struct Grabbed {
    pub texture: ID3D11Texture2D,
    pub geometry: Geometry,
    /// The picture is the same as the last one (a screen that didn't change).
    pub same: bool,
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

/// Either kind of source.
pub enum Source {
    Screen(Box<Capturer>),
    Y4m(Box<Y4mSource>),
}

impl Source {
    /// Whether the pictures arrive in real time on their own (the screen) or as fast as they are asked for.
    pub fn is_live(&self) -> bool {
        matches!(self, Source::Screen(_))
    }

    pub fn geometry(&self) -> Geometry {
        match self {
            Source::Screen(c) => c.geometry(),
            Source::Y4m(y) => y.geometry(),
        }
    }

    /// The next picture, or `None` when the source has ended (never for the screen).
    pub fn next_frame(&mut self) -> Result<Option<Grabbed>> {
        match self {
            Source::Screen(capturer) => {
                let same = capturer.grab().context("Couldn't capture the screen")? == Grab::Same;
                let texture = capturer.picture().clone();
                Ok(Some(Grabbed { texture, geometry: capturer.geometry(), same }))
            }
            Source::Y4m(y4m) => {
                let geometry = y4m.geometry();
                Ok(y4m.next_picture()?.map(|texture| Grabbed { texture: texture.clone(), geometry, same: false }))
            }
        }
    }

    pub fn restarts(&self) -> u32 {
        match self {
            Source::Screen(c) => c.restarts,
            Source::Y4m(_) => 0,
        }
    }
}
