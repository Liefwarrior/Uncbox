//! Turning the captured BGRA screen into the NV12 picture the encoder takes, and scaling it to the
//! size being sent, with the Direct3D 11 video processor: one fixed-function pass on the graphics
//! card. This is the step the FFmpeg setup could not do on the card (its `scale_d3d11` filter can't
//! take the screen capture's frames), so it did it on the processor and paid for it in frame rate.

use crate::error::{Context, Error, Result};
use crate::gpu::Gpu;
use windows::core::Interface;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};

/// `D3D11_VIDEO_PROCESSOR_COLOR_SPACE` as one number: usage (bit 0), RGB range (bit 1, 0 = full),
/// YCbCr matrix (bit 2, 1 = BT.709), xvYCC (bit 3), nominal range (bits 4-5, 1 = 16-235).
const SCREEN_COLORS: u32 = 0;
const VIDEO_COLORS: u32 = (1 << 2) | (1 << 4);

pub struct Converter {
    gpu: Gpu,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    pub out_width: u32,
    pub out_height: u32,
    outputs: Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
    next: usize,
    inputs: Vec<(usize, ID3D11VideoProcessorInputView)>,
}

impl Converter {
    /// `pool` is how many output pictures rotate: enough that the encoder is done with one before it comes round again.
    pub fn new(gpu: &Gpu, src_w: u32, src_h: u32, out_w: u32, out_h: u32, fps: u32, pool: usize) -> Result<Converter> {
        let video_device: ID3D11VideoDevice = gpu.device.cast().context("This graphics card can't convert video")?;
        let video_context: ID3D11VideoContext = gpu.context.cast().context("This graphics card can't convert video")?;
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
            InputWidth: src_w,
            InputHeight: src_h,
            OutputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
            OutputWidth: out_w,
            OutputHeight: out_h,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        // SAFETY: Direct3D 11 video calls with valid descriptors and out-pointers.
        unsafe {
            let enumerator = video_device.CreateVideoProcessorEnumerator(&content).context("This graphics card can't scale video")?;
            let processor = video_device.CreateVideoProcessor(&enumerator, 0).context("This graphics card can't scale video")?;

            let color_in = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: SCREEN_COLORS };
            let color_out = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: VIDEO_COLORS };
            let rect_in = RECT { left: 0, top: 0, right: src_w as i32, bottom: src_h as i32 };
            let rect_out = RECT { left: 0, top: 0, right: out_w as i32, bottom: out_h as i32 };
            // Convert and scale only: no driver clean-up (noise reduction, sharpening) on a desktop.
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &color_in);
            video_context.VideoProcessorSetOutputColorSpace(&processor, &color_out);
            video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&rect_in));
            video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&rect_out));
            video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&rect_out));

            let mut outputs = Vec::with_capacity(pool);
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
                gpu.device.CreateTexture2D(&desc, None, Some(&mut texture)).context("Couldn't make room for the converted picture on the graphics card")?;
                let texture = texture.ok_or_else(|| Error::new("Couldn't make room for the converted picture on the graphics card."))?;
                let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
                };
                let mut view = None;
                video_device.CreateVideoProcessorOutputView(&texture, &enumerator, &view_desc, Some(&mut view))?;
                outputs.push((texture, view.ok_or_else(|| Error::new("Couldn't prepare the converted picture."))?));
            }
            Ok(Converter {
                gpu: gpu.clone(),
                video_device,
                video_context,
                enumerator,
                processor,
                out_width: out_w,
                out_height: out_h,
                outputs,
                next: 0,
                inputs: Vec::new(),
            })
        }
    }

    fn input_view(&mut self, texture: &ID3D11Texture2D) -> Result<ID3D11VideoProcessorInputView> {
        let key = texture.as_raw() as usize;
        if let Some((_, view)) = self.inputs.iter().find(|(k, _)| *k == key) {
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
            self.video_device
                .CreateVideoProcessorInputView(texture, &self.enumerator, &desc, Some(&mut view))
                .context("The graphics card can't read the screen picture for conversion")?
        };
        let view = view.ok_or_else(|| Error::new("Couldn't prepare the screen for conversion."))?;
        self.inputs.push((key, view.clone()));
        Ok(view)
    }

    /// Converts and scales `screen` into the next picture of the pool, and returns it.
    pub fn convert(&mut self, screen: &ID3D11Texture2D) -> Result<ID3D11Texture2D> {
        let input = self.input_view(screen)?;
        let (texture, output) = self.outputs[self.next].clone();
        self.next = (self.next + 1) % self.outputs.len();
        let stream = D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: std::mem::ManuallyDrop::new(Some(input)), ..Default::default() };
        // SAFETY: the stream holds a reference that is released below; everything else is alive.
        let result = unsafe { self.video_context.VideoProcessorBlt(&self.processor, &output, 0, std::slice::from_ref(&stream)) };
        let mut stream = stream;
        // SAFETY: the one reference put in above, taken back out so it is released.
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        result.context("The graphics card couldn't convert the screen")?;
        let _ = &self.gpu;
        Ok(texture)
    }
}
