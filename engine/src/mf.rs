//! Media Foundation: the graphics card's own H.264 encoder (a "hardware MFT"; NVIDIA, AMD and Intel
//! each ship one behind this one interface) and Windows' AAC encoder for the sound.
//!
//! The picture never touches the processor: the encoder is handed Direct3D textures, through the
//! same device the screen was captured and converted on. What comes out is the small compressed
//! stream, which is all that is copied.

use crate::error::{Context, Error, Result};
use crate::gpu::Gpu;
use crate::log::debug;
use std::ptr;
use windows::core::{Interface, GUID, PWSTR};
use windows::Win32::Foundation::LUID;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::{VARIANT, VT_BOOL, VT_UI4};

/// Starts COM for the calling thread (every thread that uses Media Foundation needs this once).
pub fn init_thread() {
    // SAFETY: plain COM initialisation; "already initialised" results are fine to ignore.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// Starts Media Foundation for the whole program.
pub fn startup() -> Result<()> {
    init_thread();
    // SAFETY: documented startup call.
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL).context("Couldn't start Windows' media services") }
}

pub fn shutdown() {
    // SAFETY: pairs with `startup`.
    unsafe {
        let _ = MFShutdown();
    }
}

fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

fn variant_u32(value: u32) -> VARIANT {
    let mut v = VARIANT::default();
    // SAFETY: writing the discriminant and the matching union member of a zeroed VARIANT.
    unsafe {
        let inner = &mut *v.Anonymous.Anonymous;
        inner.vt = VT_UI4;
        inner.Anonymous.ulVal = value;
    }
    v
}

fn variant_bool(value: bool) -> VARIANT {
    let mut v = VARIANT::default();
    // SAFETY: as above.
    unsafe {
        let inner = &mut *v.Anonymous.Anonymous;
        inner.vt = VT_BOOL;
        inner.Anonymous.boolVal = windows::Win32::Foundation::VARIANT_BOOL(if value { -1 } else { 0 });
    }
    v
}

// ---- finding the encoders ----

/// A hardware H.264 encoder that is installed (not yet started).
pub struct HardwareEncoder {
    pub name: String,
    activate: IMFActivate,
}

fn string_attribute(activate: &IMFActivate, key: &GUID) -> String {
    let mut text = PWSTR::null();
    let mut len = 0u32;
    // SAFETY: out-pointers are valid; the string is freed with CoTaskMemFree as documented.
    unsafe {
        if activate.GetAllocatedString(key, &mut text, &mut len).is_err() || text.is_null() {
            return String::new();
        }
        let s = text.to_string().unwrap_or_default();
        CoTaskMemFree(Some(text.0 as *const _));
        s
    }
}

/// Whether a hardware encoder's name says it is made by `vendor` ("nvidia", "amd" or "intel"). Media Foundation lists
/// the encoders of other cards too when asked for one card's (an NVIDIA encoder is offered for an
/// Intel card on a laptop that has both), and handing a card's textures to another maker's encoder fails.
pub fn name_is_from(name: &str, vendor: &str) -> bool {
    let name = name.to_ascii_lowercase();
    match vendor {
        "nvidia" => name.contains("nvidia"),
        "amd" => name.contains("amd") || name.contains("radeon") || name.contains("advanced micro"),
        "intel" => name.contains("intel"),
        _ => false,
    }
}

/// The hardware H.264 encoders that belong to the graphics card with this LUID, made by `vendor`.
pub fn hardware_h264_encoders(luid: LUID, vendor: &str) -> Vec<HardwareEncoder> {
    let mut found = Vec::new();
    // SAFETY: MFTEnum2 hands back an array of activation objects that we take ownership of and free.
    unsafe {
        let mut attrs = None;
        if MFCreateAttributes(&mut attrs, 1).is_err() {
            return found;
        }
        let Some(attrs) = attrs else { return found };
        let _ = attrs.SetUINT64(&MFT_ENUM_ADAPTER_LUID, pack(luid.HighPart as u32, luid.LowPart));
        let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let mut list: *mut Option<IMFActivate> = ptr::null_mut();
        let mut count = 0u32;
        if MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, None, Some(&output), &attrs, &mut list, &mut count)
            .is_err()
            || list.is_null()
        {
            return found;
        }
        for i in 0..count as usize {
            if let Some(activate) = ptr::read(list.add(i)) {
                let name = string_attribute(&activate, &MFT_FRIENDLY_NAME_Attribute);
                if name_is_from(&name, vendor) {
                    found.push(HardwareEncoder { name, activate });
                } else {
                    debug(&format!("skipping the encoder {name}: it is not {vendor}'s"));
                }
            }
        }
        CoTaskMemFree(Some(list as *const _));
    }
    found
}

// ---- the video encoder ----

#[derive(Debug, Clone)]
pub struct VideoConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub kbps: u32,
    /// Frames between keyframes.
    pub gop: u32,
    /// B-frames between reference frames; 0 for none.
    pub bframes: u32,
    /// 0 is fastest, 100 best looking.
    pub quality: u32,
}

/// One compressed picture, as the encoder wrote it (Annex B).
#[derive(Debug, Clone)]
pub struct EncodedVideo {
    pub data: Vec<u8>,
    /// When the picture is shown, in 100 ns units from the start.
    pub pts: i64,
    /// When it is decoded, if the encoder says (it differs from `pts` when B-frames reorder).
    pub dts: Option<i64>,
    pub clean_point: bool,
}

pub struct VideoEncoder {
    transform: IMFTransform,
    /// Held so the shared graphics device stays valid for as long as the encoder runs.
    _manager: IMFDXGIDeviceManager,
    events: Option<IMFMediaEventGenerator>,
    codec: Option<ICodecAPI>,
    provides_samples: bool,
    output_size: u32,
    need_input: u32,
    drained: bool,
    pub name: String,
    pub is_async: bool,
    /// The B-frames the encoder accepted (0 if it took none).
    pub bframes: u32,
    /// Settings the encoder turned down (see [`apply_codec_settings`]).
    pub refused: Vec<&'static str>,
}

impl VideoEncoder {
    pub fn new(gpu: &Gpu, encoder: &HardwareEncoder, cfg: &VideoConfig) -> Result<VideoEncoder> {
        // SAFETY: Media Foundation COM calls on objects created here; arguments are valid for the calls.
        unsafe {
            let transform: IMFTransform = encoder.activate.ActivateObject().context("Couldn't start the graphics card's video encoder")?;
            let attrs = transform.GetAttributes().ok();
            let is_async = attrs.as_ref().and_then(|a| a.GetUINT32(&MF_TRANSFORM_ASYNC).ok()).unwrap_or(0) != 0;
            if is_async {
                if let Some(a) = &attrs {
                    let _ = a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
                }
            }
            // The encoder reads the textures through the same Direct3D device.
            let mut token = 0u32;
            let mut manager: Option<IMFDXGIDeviceManager> = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager).context("Couldn't share the graphics card with the video encoder")?;
            let manager = manager.ok_or_else(|| Error::new("Couldn't share the graphics card with the video encoder."))?;
            manager.ResetDevice(&gpu.device, token)?;
            transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
                .context("The video encoder can't use this graphics card's textures")?;

            let codec: Option<ICodecAPI> = transform.cast().ok();

            // The encoder reads these properties when the types are set, so they come first.
            let mut bframes = 0;
            let mut refused = Vec::new();
            if let Some(codec) = &codec {
                let applied = apply_codec_settings(codec, cfg);
                bframes = applied.bframes;
                refused = applied.refused;
                // Without B-frames, pictures are handed over as soon as they are made. With them the
                // encoder has to hold a few back, which is the cost of the smaller stream.
                let low_latency = bframes == 0;
                let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &variant_bool(low_latency));
                if let Some(a) = &attrs {
                    let _ = a.SetUINT32(&MF_LOW_LATENCY, u32::from(low_latency));
                }
            }

            let out_type = MFCreateMediaType()?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            out_type.SetUINT32(&MF_MT_AVG_BITRATE, cfg.kbps * 1000)?;
            out_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(cfg.width, cfg.height))?;
            out_type.SetUINT64(&MF_MT_FRAME_RATE, pack(cfg.fps, 1))?;
            out_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            out_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            out_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
            out_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
            out_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            out_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            transform.SetOutputType(0, &out_type, 0).context("The video encoder doesn't take this picture size or rate")?;

            let in_type = MFCreateMediaType()?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            in_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(cfg.width, cfg.height))?;
            in_type.SetUINT64(&MF_MT_FRAME_RATE, pack(cfg.fps, 1))?;
            in_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            in_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            in_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
            in_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
            in_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            in_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            transform.SetInputType(0, &in_type, 0).context("The video encoder doesn't take the converted picture")?;

            let info = transform.GetOutputStreamInfo(0)?;
            let events: Option<IMFMediaEventGenerator> = if is_async { transform.cast().ok() } else { None };

            transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

            Ok(VideoEncoder {
                transform,
                _manager: manager,
                events,
                codec,
                provides_samples: info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0,
                output_size: info.cbSize.max(1 << 20),
                need_input: 0,
                drained: false,
                name: encoder.name.clone(),
                is_async,
                bframes,
                refused,
            })
        }
    }

    /// Wraps a converted NV12 texture as a sample for the encoder.
    pub fn sample_for(texture: &ID3D11Texture2D, pts: i64, duration: i64) -> Result<IMFSample> {
        // SAFETY: wraps a live texture; the buffer keeps its own reference to it.
        unsafe {
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)?;
            if let Ok(flat) = buffer.cast::<IMF2DBuffer>() {
                if let Ok(len) = flat.GetContiguousLength() {
                    buffer.SetCurrentLength(len)?;
                }
            }
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(pts)?;
            sample.SetSampleDuration(duration)?;
            Ok(sample)
        }
    }

    /// Whether the encoder is waiting for a picture.
    pub fn wants_input(&self) -> bool {
        !self.is_async || self.need_input > 0
    }

    /// Hands the encoder one picture. Call only when [`wants_input`](Self::wants_input).
    pub fn feed(&mut self, sample: &IMFSample, out: &mut Vec<EncodedVideo>) -> Result<()> {
        // SAFETY: the sample is a live object; ProcessInput takes its own reference.
        unsafe {
            self.transform.ProcessInput(0, sample, 0).context("The video encoder refused a picture")?;
        }
        if self.is_async {
            self.need_input = self.need_input.saturating_sub(1);
        } else {
            self.pull_all(out)?;
        }
        Ok(())
    }

    /// Collects what the encoder has ready (and, for the asynchronous kind, notes what it asks for).
    pub fn poll(&mut self, out: &mut Vec<EncodedVideo>) -> Result<()> {
        let Some(events) = self.events.clone() else { return Ok(()) };
        loop {
            // SAFETY: GetEvent with NO_WAIT is a plain query.
            let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(e) => e,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                Err(e) => return Err(Error::from(e)).context("The video encoder stopped answering"),
            };
            // SAFETY: as above.
            let kind = unsafe { event.GetType()? };
            let kind = MF_EVENT_TYPE(kind as i32);
            if kind == METransformNeedInput {
                self.need_input += 1;
            } else if kind == METransformHaveOutput {
                self.pull_one(out)?;
            } else if kind == METransformDrainComplete {
                self.drained = true;
            }
        }
    }

    fn pull_all(&mut self, out: &mut Vec<EncodedVideo>) -> Result<()> {
        while self.pull_one(out)? {}
        Ok(())
    }

    /// Takes one finished picture from the encoder, if it has one.
    fn pull_one(&mut self, out: &mut Vec<EncodedVideo>) -> Result<bool> {
        // SAFETY: the output buffer struct is filled in by ProcessOutput; the sample it returns
        // is ours to release, which `ManuallyDrop::take` does.
        unsafe {
            let own_sample = if self.provides_samples {
                None
            } else {
                let buffer = MFCreateMemoryBuffer(self.output_size)?;
                let sample = MFCreateSample()?;
                sample.AddBuffer(&buffer)?;
                Some(sample)
            };
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: std::mem::ManuallyDrop::new(own_sample),
                dwStatus: 0,
                pEvents: std::mem::ManuallyDrop::new(None),
            }];
            let mut status = 0u32;
            let result = self.transform.ProcessOutput(0, &mut buffers, &mut status);
            let sample = std::mem::ManuallyDrop::take(&mut buffers[0].pSample);
            let _events = std::mem::ManuallyDrop::take(&mut buffers[0].pEvents);
            match result {
                Ok(()) => {
                    if let Some(sample) = sample {
                        out.push(read_video_sample(&sample)?);
                    }
                    Ok(true)
                }
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(false),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    // The encoder settled on a different output format: accept what it offers.
                    if let Ok(t) = self.transform.GetOutputAvailableType(0, 0) {
                        let _ = self.transform.SetOutputType(0, &t, 0);
                    }
                    Ok(true)
                }
                Err(e) => Err(Error::from(e)).context("The video encoder failed to deliver a picture"),
            }
        }
    }

    /// Asks the encoder to finish what it holds; the rest comes out of [`poll`](Self::poll) / here.
    pub fn drain(&mut self, out: &mut Vec<EncodedVideo>, give_up: std::time::Duration) {
        // SAFETY: plain messages.
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
        }
        let deadline = std::time::Instant::now() + give_up;
        while std::time::Instant::now() < deadline {
            if self.is_async {
                if self.poll(out).is_err() || self.drained {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            } else {
                let _ = self.pull_all(out);
                break;
            }
        }
    }

    /// Makes the next picture a keyframe (used to start a stream, and to recover after dropped pictures).
    pub fn force_keyframe(&self) {
        if let Some(codec) = &self.codec {
            // SAFETY: plain property set.
            unsafe {
                let _ = codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &variant_u32(1));
            }
        }
    }
}

/// What an encoder took of the settings asked for through the "codec API" properties.
#[derive(Debug, Clone, Default)]
pub struct AppliedSettings {
    /// B-frames the encoder accepted (0 if it takes none).
    pub bframes: u32,
    /// The settings it turned down, in words.
    pub refused: Vec<&'static str>,
}

/// The rate control, keyframe interval and quality settings, which Media Foundation takes as
/// "codec API" properties. These are the equivalents of what FFmpeg's `h264_amf` and `h264_qsv` are
/// asked for (`-quality quality` / `-preset slower`, B-frames); look-ahead, pre-analysis and adaptive
/// quantisation have no Media Foundation setting, so they cannot be asked for. Every result is
/// checked: what an encoder refuses is listed, not ignored.
///
/// # Safety
/// `codec` must be a live interface; the calls are plain property sets.
unsafe fn apply_codec_settings(codec: &ICodecAPI, cfg: &VideoConfig) -> AppliedSettings {
    fn set(codec: &ICodecAPI, applied: &mut AppliedSettings, name: &'static str, key: &GUID, value: VARIANT) -> bool {
        // SAFETY: as the contract of `apply_codec_settings` says.
        let result = unsafe { codec.SetValue(key, &value) };
        if let Err(e) = &result {
            debug(&format!("the video encoder doesn't take setting {name}: {e}"));
            if !applied.refused.contains(&name) {
                applied.refused.push(name);
            }
        }
        result.is_ok()
    }
    let mut applied = AppliedSettings::default();
    let a = &mut applied;
    set(codec, a, "constant bitrate", &CODECAPI_AVEncCommonRateControlMode, variant_u32(eAVEncCommonRateControlMode_CBR.0 as u32));
    // This encoder's "constant" bitrate runs a few percent over on busy pictures (measured about 7 to 13
    // percent), and a stream over the limit it was told is what a service complains about. So it is aimed
    // a little low; busy pictures then come out at the rate that was asked for.
    let aim = cfg.kbps * 93 / 100;
    set(codec, a, "mean bitrate", &CODECAPI_AVEncCommonMeanBitRate, variant_u32(aim * 1000));
    set(codec, a, "maximum bitrate", &CODECAPI_AVEncCommonMaxBitRate, variant_u32(aim * 1000));
    // The buffer is twice the bitrate (two seconds of it), counted in bits.
    set(codec, a, "buffer size", &CODECAPI_AVEncCommonBufferSize, variant_u32(cfg.kbps * 2000));
    set(codec, a, "keyframe interval", &CODECAPI_AVEncMPVGOPSize, variant_u32(cfg.gop));
    set(codec, a, "CABAC", &CODECAPI_AVEncH264CABACEnable, variant_bool(true));
    set(codec, a, "quality over speed", &CODECAPI_AVEncCommonQualityVsSpeed, variant_u32(cfg.quality));
    // Not "real time": the stream is a few seconds behind anyway, and the encoder may take its time.
    set(codec, a, "no real-time mode", &CODECAPI_AVEncCommonRealTime, variant_bool(false));
    if cfg.quality >= 80 {
        // A second pass where the encoder has one.
        set(codec, a, "two passes", &CODECAPI_AVEncCommonMultipassMode, variant_u32(2));
    }
    for n in (1..=cfg.bframes).rev() {
        if set(codec, a, "B-frames", &CODECAPI_AVEncMPVDefaultBPictureCount, variant_u32(n)) {
            // The refusals of larger counts on the way down are not refusals of B-frames.
            a.refused.retain(|r| *r != "B-frames");
            a.bframes = n;
            break;
        }
    }
    applied
}

fn read_video_sample(sample: &IMFSample) -> Result<EncodedVideo> {
    // SAFETY: the buffer is locked while its bytes are copied out, then unlocked.
    unsafe {
        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut data_ptr: *mut u8 = ptr::null_mut();
        let mut len = 0u32;
        buffer.Lock(&mut data_ptr, None, Some(&mut len))?;
        let data = if data_ptr.is_null() { Vec::new() } else { std::slice::from_raw_parts(data_ptr, len as usize).to_vec() };
        buffer.Unlock()?;
        Ok(EncodedVideo {
            data,
            pts: sample.GetSampleTime().unwrap_or(0),
            dts: sample.GetUINT64(&MFSampleExtension_DecodeTimestamp).ok().map(|v| v as i64),
            clean_point: sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0,
        })
    }
}

// ---- the sound encoder ----

/// AAC-LC at 48 kHz stereo, from 16-bit sound.
pub struct AudioEncoder {
    transform: IMFTransform,
    output_size: u32,
    provides_samples: bool,
    pub frames_out: u64,
}

pub const AAC_FRAME_SAMPLES: u64 = 1024;
pub const SAMPLE_RATE: u32 = 48_000;

impl AudioEncoder {
    pub fn new(kbps: u32) -> Result<AudioEncoder> {
        // SAFETY: Media Foundation COM calls on objects created here.
        unsafe {
            let transform: IMFTransform = CoCreateInstance(&AACMFTEncoder, None, CLSCTX_INPROC_SERVER).context("Windows' sound encoder isn't available")?;
            let out_type = MFCreateMediaType()?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            out_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            out_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
            out_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            out_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, kbps * 125)?;
            out_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 1)?;
            out_type.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?; // raw AAC, no ADTS headers
            out_type.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)?;
            transform.SetOutputType(0, &out_type, 0).context("Windows' sound encoder doesn't take this bitrate")?;

            let in_type = MFCreateMediaType()?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            in_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
            in_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)?;
            in_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, SAMPLE_RATE * 4)?;
            transform.SetInputType(0, &in_type, 0).context("Windows' sound encoder doesn't take the sound")?;

            let info = transform.GetOutputStreamInfo(0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(AudioEncoder {
                transform,
                output_size: info.cbSize.max(8192),
                provides_samples: info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0,
                frames_out: 0,
            })
        }
    }

    /// Encodes 16-bit interleaved stereo (`pcm`), returning any AAC frames that are ready.
    pub fn encode(&mut self, pcm: &[i16], time_100ns: i64, out: &mut Vec<Vec<u8>>) -> Result<()> {
        // SAFETY: the input buffer is locked while the sound is copied in; the rest are plain calls.
        unsafe {
            let bytes = pcm.len() * 2;
            let buffer = MFCreateMemoryBuffer(bytes as u32)?;
            let mut dst: *mut u8 = ptr::null_mut();
            buffer.Lock(&mut dst, None, None)?;
            ptr::copy_nonoverlapping(pcm.as_ptr() as *const u8, dst, bytes);
            buffer.Unlock()?;
            buffer.SetCurrentLength(bytes as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(time_100ns)?;
            sample.SetSampleDuration((pcm.len() as i64 / 2) * 10_000_000 / i64::from(SAMPLE_RATE))?;
            self.transform.ProcessInput(0, &sample, 0).context("The sound encoder refused some sound")?;
        }
        self.pull(out)
    }

    fn pull(&mut self, out: &mut Vec<Vec<u8>>) -> Result<()> {
        loop {
            // SAFETY: see `VideoEncoder::pull_one`.
            unsafe {
                let own = if self.provides_samples {
                    None
                } else {
                    let buffer = MFCreateMemoryBuffer(self.output_size)?;
                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&buffer)?;
                    Some(sample)
                };
                let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    pSample: std::mem::ManuallyDrop::new(own),
                    dwStatus: 0,
                    pEvents: std::mem::ManuallyDrop::new(None),
                }];
                let mut status = 0u32;
                let result = self.transform.ProcessOutput(0, &mut buffers, &mut status);
                let sample = std::mem::ManuallyDrop::take(&mut buffers[0].pSample);
                let _events = std::mem::ManuallyDrop::take(&mut buffers[0].pEvents);
                match result {
                    Ok(()) => {
                        let Some(sample) = sample else { return Ok(()) };
                        let buffer = sample.ConvertToContiguousBuffer()?;
                        let mut data: *mut u8 = ptr::null_mut();
                        let mut len = 0u32;
                        buffer.Lock(&mut data, None, Some(&mut len))?;
                        let frame = if data.is_null() { Vec::new() } else { std::slice::from_raw_parts(data, len as usize).to_vec() };
                        buffer.Unlock()?;
                        if !frame.is_empty() {
                            self.frames_out += 1;
                            out.push(frame);
                        }
                    }
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
                    Err(e) => return Err(Error::from(e)),
                }
            }
        }
    }

    /// Finishes the sound: whatever the encoder was still holding comes out.
    pub fn drain(&mut self, out: &mut Vec<Vec<u8>>) {
        // SAFETY: plain messages.
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
        }
        let _ = self.pull(out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_encoder_is_matched_to_its_makers_card_by_name() {
        assert!(name_is_from("NVIDIA H.264 Encoder MFT", "nvidia"));
        assert!(name_is_from("AMDh264Encoder", "amd"));
        assert!(name_is_from("AMD H.264 Encoder MFT", "amd"));
        assert!(name_is_from("Intel\u{ae} Quick Sync Video H.264 Encoder MFT", "intel"));
        // Windows offers the NVIDIA encoder when asked for an Intel card's on a laptop with both.
        assert!(!name_is_from("NVIDIA H.264 Encoder MFT", "intel"));
        assert!(!name_is_from("Intel\u{ae} Quick Sync Video H.264 Encoder MFT", "nvidia"));
        assert!(!name_is_from("AMDh264Encoder", "nvidia"));
        assert!(!name_is_from("Something", "other"));
        assert!(!name_is_from("", "nvidia"));
    }

    #[test]
    fn packs_a_luid_into_one_number() {
        assert_eq!(pack(1, 2), (1u64 << 32) | 2);
        assert_eq!(pack(0, 0xFFFF_FFFF), 0xFFFF_FFFF);
    }
}
