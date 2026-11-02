//! NVIDIA's encoder, used directly (NVENC) instead of through Media Foundation.
//!
//! Media Foundation's NVIDIA encoder takes no B-frames, no look-ahead and no multi-pass, so a
//! stream made with it looks worse at the same bitrate than FFmpeg's `h264_nvenc`. This talks to
//! the driver's own encoder interface (`nvEncodeAPI64.dll`, loaded when it is needed, so the
//! program still starts on a PC without it) and asks for what FFmpeg asks for. See `tuning.rs` for
//! the settings and `nvapi.rs` for the interface.
//!
//! The pictures the video processor makes (NV12 Direct3D textures) are registered with the encoder
//! and read from where they are: nothing is copied. Each picture stays with the encoder until its
//! compressed form has been taken out, which with look-ahead and B-frames is a couple of dozen
//! pictures later, so the caller is told which pictures are free again ([`Nvenc::take_released`]).
//!
//! Pictures come out in decode order, as the encoder reorders them; each carries the time stamp it
//! was given (when it is shown) and a decode time worked out by [`DtsClock`].

use crate::error::{Context, Error, Result};
use crate::log::debug;
use crate::mf::EncodedVideo;
use crate::nvapi::{self as api, caps, slot, zeroed, Guid, Status};
use crate::reorder::DtsClock;
use crate::tuning::{self, NvencParams};
use std::collections::VecDeque;
use std::ffi::{c_char, c_void, CStr};
use windows::core::{s, w, Interface};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

type FnGetMaxVersion = unsafe extern "C" fn(*mut u32) -> Status;
type FnCreateInstance = unsafe extern "C" fn(*mut api::FunctionList) -> Status;
type FnOpenSessionEx = unsafe extern "C" fn(*mut api::OpenSessionExParams, *mut *mut c_void) -> Status;
type FnGetCaps = unsafe extern "C" fn(*mut c_void, Guid, *mut api::CapsParam, *mut i32) -> Status;
type FnGetPresetConfigEx = unsafe extern "C" fn(*mut c_void, Guid, Guid, u32, *mut api::PresetConfig) -> Status;
type FnInitialize = unsafe extern "C" fn(*mut c_void, *mut api::InitializeParams) -> Status;
type FnCreateBitstream = unsafe extern "C" fn(*mut c_void, *mut api::CreateBitstreamBuffer) -> Status;
type FnDestroyBitstream = unsafe extern "C" fn(*mut c_void, *mut c_void) -> Status;
type FnEncode = unsafe extern "C" fn(*mut c_void, *mut api::PicParams) -> Status;
type FnLock = unsafe extern "C" fn(*mut c_void, *mut api::LockBitstream) -> Status;
type FnUnlock = unsafe extern "C" fn(*mut c_void, *mut c_void) -> Status;
type FnRegister = unsafe extern "C" fn(*mut c_void, *mut api::RegisterResource) -> Status;
type FnUnregister = unsafe extern "C" fn(*mut c_void, *mut c_void) -> Status;
type FnMap = unsafe extern "C" fn(*mut c_void, *mut api::MapInputResource) -> Status;
type FnUnmap = unsafe extern "C" fn(*mut c_void, *mut c_void) -> Status;
type FnDestroy = unsafe extern "C" fn(*mut c_void) -> Status;
type FnLastError = unsafe extern "C" fn(*mut c_void) -> *const c_char;

/// The driver's functions, taken from its function list.
#[derive(Clone, Copy)]
struct Funcs {
    open_session_ex: FnOpenSessionEx,
    get_caps: FnGetCaps,
    get_preset_config_ex: FnGetPresetConfigEx,
    initialize: FnInitialize,
    create_bitstream: FnCreateBitstream,
    destroy_bitstream: FnDestroyBitstream,
    encode: FnEncode,
    lock: FnLock,
    unlock: FnUnlock,
    register: FnRegister,
    unregister: FnUnregister,
    map: FnMap,
    unmap: FnUnmap,
    destroy: FnDestroy,
    last_error: Option<FnLastError>,
}

/// One compressed picture's slot: where the encoder writes it, and the input it was made from.
struct InFlight {
    surface: usize,
    mapped: *mut c_void,
    token: usize,
}

struct Registered {
    key: usize,
    /// Keeps the texture alive for as long as the encoder knows it.
    _texture: ID3D11Texture2D,
    handle: *mut c_void,
}

pub struct Nvenc {
    f: Funcs,
    /// The version numbers for the structures, as the driver's interface version needs them.
    v: api::Versions,
    session: *mut c_void,
    _module: HMODULE,
    _device: ID3D11Device,
    pub params: NvencParams,
    width: u32,
    height: u32,
    outputs: Vec<*mut c_void>,
    free: Vec<usize>,
    registered: Vec<Registered>,
    /// Pictures given to the encoder, waiting for it to say their output can be taken.
    queued: VecDeque<InFlight>,
    ready: VecDeque<InFlight>,
    dts: DtsClock,
    frame_idx: u32,
    released: Vec<usize>,
    pub surface_count: usize,
    /// Pictures the encoder holds before the first is asked for (one fewer than there are).
    async_depth: usize,
}

// SAFETY: the encoder is created on one thread and then used by one thread at a time (the encoder
// thread); NVENC sessions can be used from any single thread. The raw pointers are handles the
// driver gave this struct and nobody else holds.
unsafe impl Send for Nvenc {}

/// The interface versions to speak to a driver that answered `max` to `NvEncodeAPIGetMaxSupportedVersion`.
fn check_version(max: u32) -> Result<api::Versions> {
    api::Versions::for_driver(max).ok_or_else(|| {
        Error::new(format!(
            "The NVIDIA graphics driver is older than the direct encoder needs (it speaks NVENC {}.{}, the engine needs {}.{}).",
            max >> 4,
            max & 15,
            api::API_MAJOR,
            api::API_MINOR_OLDEST
        ))
    })
}

fn status_error(what: &str, status: Status, f: Option<&Funcs>, session: *mut c_void) -> Error {
    let mut detail = String::new();
    if let (Some(f), false) = (f, session.is_null()) {
        if let Some(last) = f.last_error {
            // SAFETY: the driver returns a NUL-terminated message it owns, or null.
            let text = unsafe { last(session) };
            if !text.is_null() {
                detail = unsafe { CStr::from_ptr(text) }.to_string_lossy().trim().to_string();
            }
        }
    }
    debug(&format!("NVENC: {what} failed: {} ({status}) {detail}", api::status_name(status)));
    Error::new(format!("The NVIDIA video encoder refused: {what} ({}).", api::status_name(status)))
}

impl Nvenc {
    /// Opens a session on `device` (the graphics card's Direct3D device) for pictures of `width` x
    /// `height` and starts it with `params`. Fails, with a sentence saying what the card or driver
    /// refused, if it can't: the caller then tries gentler settings or another encoder.
    pub fn open(device: &ID3D11Device, width: u32, height: u32, params: &NvencParams) -> Result<Nvenc> {
        // SAFETY: loading a system DLL and calling the functions it exports with the structures of
        // its published interface (see nvapi.rs); every pointer passed is to a live local.
        unsafe {
            let module = LoadLibraryW(w!("nvEncodeAPI64.dll")).map_err(|_| Error::new("There is no NVIDIA video encoder on this PC."))?;
            let get_max =
                GetProcAddress(module, s!("NvEncodeAPIGetMaxSupportedVersion")).ok_or_else(|| Error::new("The NVIDIA video encoder driver is incomplete."))?;
            let create = GetProcAddress(module, s!("NvEncodeAPICreateInstance")).ok_or_else(|| Error::new("The NVIDIA video encoder driver is incomplete."))?;
            let get_max: FnGetMaxVersion = std::mem::transmute(get_max);
            let create: FnCreateInstance = std::mem::transmute(create);
            let mut max = 0u32;
            let status = get_max(&mut max);
            if status != api::SUCCESS {
                return Err(status_error("asking the driver's version", status, None, std::ptr::null_mut()));
            }
            let versions = check_version(max)?;

            let mut list: api::FunctionList = zeroed();
            list.version = versions.function_list;
            let status = create(&mut list);
            if status != api::SUCCESS {
                return Err(status_error("loading the encoder interface", status, None, std::ptr::null_mut()));
            }
            let get = |index: usize| -> Result<usize> {
                match list.slots[index] {
                    0 => Err(Error::new("The NVIDIA video encoder driver is incomplete.")),
                    p => Ok(p),
                }
            };
            let f = Funcs {
                open_session_ex: std::mem::transmute::<usize, FnOpenSessionEx>(get(slot::OPEN_ENCODE_SESSION_EX)?),
                get_caps: std::mem::transmute::<usize, FnGetCaps>(get(slot::GET_ENCODE_CAPS)?),
                get_preset_config_ex: std::mem::transmute::<usize, FnGetPresetConfigEx>(get(slot::GET_ENCODE_PRESET_CONFIG_EX)?),
                initialize: std::mem::transmute::<usize, FnInitialize>(get(slot::INITIALIZE_ENCODER)?),
                create_bitstream: std::mem::transmute::<usize, FnCreateBitstream>(get(slot::CREATE_BITSTREAM_BUFFER)?),
                destroy_bitstream: std::mem::transmute::<usize, FnDestroyBitstream>(get(slot::DESTROY_BITSTREAM_BUFFER)?),
                encode: std::mem::transmute::<usize, FnEncode>(get(slot::ENCODE_PICTURE)?),
                lock: std::mem::transmute::<usize, FnLock>(get(slot::LOCK_BITSTREAM)?),
                unlock: std::mem::transmute::<usize, FnUnlock>(get(slot::UNLOCK_BITSTREAM)?),
                register: std::mem::transmute::<usize, FnRegister>(get(slot::REGISTER_RESOURCE)?),
                unregister: std::mem::transmute::<usize, FnUnregister>(get(slot::UNREGISTER_RESOURCE)?),
                map: std::mem::transmute::<usize, FnMap>(get(slot::MAP_INPUT_RESOURCE)?),
                unmap: std::mem::transmute::<usize, FnUnmap>(get(slot::UNMAP_INPUT_RESOURCE)?),
                destroy: std::mem::transmute::<usize, FnDestroy>(get(slot::DESTROY_ENCODER)?),
                last_error: match list.slots[slot::GET_LAST_ERROR_STRING] {
                    0 => None,
                    p => Some(std::mem::transmute::<usize, FnLastError>(p)),
                },
            };

            let mut open: api::OpenSessionExParams = zeroed();
            open.version = versions.open_session_ex;
            open.device_type = api::DEVICE_TYPE_DIRECTX;
            open.device = device.as_raw();
            open.api_version = versions.api;
            let mut session: *mut c_void = std::ptr::null_mut();
            let status = (f.open_session_ex)(&mut open, &mut session);
            if status != api::SUCCESS || session.is_null() {
                return Err(status_error("opening a session", status, Some(&f), std::ptr::null_mut()));
            }

            // From here the session exists: if anything fails, `me` is dropped and tidies up.
            let mut me = Nvenc {
                f,
                v: versions,
                session,
                _module: module,
                _device: device.clone(),
                params: params.clone(),
                width,
                height,
                outputs: Vec::new(),
                free: Vec::new(),
                registered: Vec::new(),
                queued: VecDeque::new(),
                ready: VecDeque::new(),
                dts: DtsClock::new(params.bframes, 10_000_000 / i64::from(params.fps.max(1))),
                frame_idx: 0,
                released: Vec::new(),
                surface_count: tuning::surfaces(params.lookahead, params.bframes),
                async_depth: tuning::surfaces(params.lookahead, params.bframes) - 1,
            };
            me.check_support()?;
            me.initialize()?;
            for _ in 0..me.surface_count {
                let mut create: api::CreateBitstreamBuffer = zeroed();
                create.version = me.v.create_bitstream_buffer;
                let status = (me.f.create_bitstream)(me.session, &mut create);
                if status != api::SUCCESS {
                    return Err(status_error("making room for the output", status, Some(&me.f), me.session));
                }
                me.outputs.push(create.bitstream_buffer);
                me.free.push(me.outputs.len() - 1);
            }
            Ok(me)
        }
    }

    fn cap(&self, what: u32) -> i32 {
        let mut param: api::CapsParam = zeroed();
        param.version = self.v.caps_param;
        param.caps_to_query = what;
        let mut value = 0i32;
        // SAFETY: valid session and pointers to live locals.
        let status = unsafe { (self.f.get_caps)(self.session, api::CODEC_H264, &mut param, &mut value) };
        if status == api::SUCCESS {
            value
        } else {
            0
        }
    }

    /// Refuses, in words, what this card can't do of what was asked, before the driver is made to try.
    fn check_support(&self) -> Result<()> {
        let p = &self.params;
        let refuse = |what: &str| -> Result<()> {
            debug(&format!("NVENC: this card can't do {what}"));
            Err(Error::new(format!("This NVIDIA card's encoder can't do {what}.")))
        };
        let (max_w, max_h) = (self.cap(caps::WIDTH_MAX), self.cap(caps::HEIGHT_MAX));
        if (max_w > 0 && self.width > max_w as u32) || (max_h > 0 && self.height > max_h as u32) {
            return refuse(&format!("pictures of {}x{}", self.width, self.height));
        }
        if p.bframes > 0 && self.cap(caps::NUM_MAX_BFRAMES) < p.bframes as i32 {
            return refuse(&format!("{} B-frames", p.bframes));
        }
        if p.b_frame_ref == tuning::BFrameRef::Middle && self.cap(caps::SUPPORT_BFRAME_REF_MODE) & 2 == 0 {
            return refuse("B-frames as references");
        }
        if p.lookahead > 0 && self.cap(caps::SUPPORT_LOOKAHEAD) == 0 {
            return refuse("look-ahead");
        }
        if p.temporal_aq && self.cap(caps::SUPPORT_TEMPORAL_AQ) == 0 {
            return refuse("adaptive quantisation over time");
        }
        Ok(())
    }

    fn initialize(&mut self) -> Result<()> {
        let p = self.params.clone();
        let mut preset: api::PresetConfig = zeroed();
        preset.version = self.v.preset_config;
        preset.config.version = self.v.config;
        // SAFETY: valid session; the structures are live locals of the sizes the header says.
        let status =
            unsafe { (self.f.get_preset_config_ex)(self.session, api::CODEC_H264, api::preset_guid(p.preset), api::TUNING_INFO_HIGH_QUALITY, &mut preset) };
        if status != api::SUCCESS {
            return Err(status_error("reading the preset", status, Some(&self.f), self.session));
        }
        let mut config = preset.config;
        api::apply_params(&mut config, &p, &self.v);

        let mut init: api::InitializeParams = zeroed();
        init.version = self.v.initialize_params;
        init.encode_guid = api::CODEC_H264;
        init.preset_guid = api::preset_guid(p.preset);
        init.encode_width = self.width;
        init.encode_height = self.height;
        let divisor = gcd(self.width, self.height).max(1);
        init.dar_width = self.width / divisor;
        init.dar_height = self.height / divisor;
        init.frame_rate_num = p.fps;
        init.frame_rate_den = 1;
        init.enable_encode_async = 0;
        init.enable_ptd = 1;
        init.tuning_info = api::TUNING_INFO_HIGH_QUALITY;
        init.encode_config = &mut config;
        // SAFETY: `config` outlives the call.
        let status = unsafe { (self.f.initialize)(self.session, &mut init) };
        if status != api::SUCCESS {
            return Err(status_error("starting the encoder with these settings", status, Some(&self.f), self.session));
        }
        Ok(())
    }

    /// Finds the handle the encoder knows `texture` by, registering it the first time it is seen.
    fn register(&mut self, texture: &ID3D11Texture2D) -> Result<*mut c_void> {
        let key = texture.as_raw() as usize;
        if let Some(r) = self.registered.iter().find(|r| r.key == key) {
            return Ok(r.handle);
        }
        let mut reg: api::RegisterResource = zeroed();
        reg.version = self.v.register_resource;
        reg.resource_type = api::INPUT_RESOURCE_TYPE_DIRECTX;
        reg.width = self.width;
        reg.height = self.height;
        reg.pitch = 0;
        reg.sub_resource_index = 0;
        reg.resource_to_register = texture.as_raw();
        reg.buffer_format = api::BUFFER_FORMAT_NV12;
        // SAFETY: valid session; `reg` is a live local; the texture is a live Direct3D texture on the session's device.
        let status = unsafe { (self.f.register)(self.session, &mut reg) };
        if status != api::SUCCESS {
            return Err(status_error("sharing a picture with the encoder", status, Some(&self.f), self.session));
        }
        self.registered.push(Registered { key, _texture: texture.clone(), handle: reg.registered_resource });
        Ok(reg.registered_resource)
    }

    /// Hands the encoder a picture. `token` is the caller's name for it (it comes back from
    /// [`take_released`](Self::take_released) when the encoder is done with the texture); `pts` is when it is
    /// shown, in 100 ns units. Whatever pictures are finished by now are added to `out`.
    pub fn feed(&mut self, texture: &ID3D11Texture2D, token: usize, pts: i64, force_keyframe: bool, out: &mut Vec<EncodedVideo>) -> Result<()> {
        let handle = self.register(texture)?;
        let surface = self.free.pop().ok_or_else(|| Error::new("The NVIDIA video encoder ran out of room."))?;
        let mut map: api::MapInputResource = zeroed();
        map.version = self.v.map_input_resource;
        map.registered_resource = handle;
        // SAFETY: valid session; `map` is a live local; `handle` came from `register`.
        let status = unsafe { (self.f.map)(self.session, &mut map) };
        if status != api::SUCCESS {
            self.free.push(surface);
            return Err(status_error("reading a picture", status, Some(&self.f), self.session));
        }

        let mut pic: api::PicParams = zeroed();
        pic.version = self.v.pic_params;
        pic.input_width = self.width;
        pic.input_height = self.height;
        pic.input_pitch = self.width;
        pic.encode_pic_flags = if force_keyframe { api::PIC_FLAG_FORCE_IDR | api::PIC_FLAG_OUTPUT_SPSPPS } else { 0 };
        pic.frame_idx = self.frame_idx;
        // Time stamps go in as frame numbers, as FFmpeg's do (its codec time base is one frame): the
        // encoder's rate control reads them, and 100 ns ticks make it think the pictures are very far apart.
        pic.input_time_stamp = frame_number(pts, self.params.fps) as u64;
        pic.input_duration = 1;
        pic.input_buffer = map.mapped_resource;
        pic.output_bitstream = self.outputs[surface];
        pic.buffer_fmt = map.mapped_buffer_fmt;
        pic.picture_struct = api::PIC_STRUCT_FRAME;
        pic.picture_type = 0;
        // One slice, as in the configuration.
        pic.codec_pic_params.h264.slice_mode = 3;
        pic.codec_pic_params.h264.slice_mode_data = 1;
        self.frame_idx = self.frame_idx.wrapping_add(1);
        self.dts.picture_in(pts);

        let mut status = self.encode(&mut pic);
        // "Busy" means pictures have to be taken out before more go in.
        for _ in 0..200 {
            if status != api::ERR_ENCODER_BUSY {
                break;
            }
            self.collect(out, false)?;
            std::thread::sleep(std::time::Duration::from_millis(1));
            status = self.encode(&mut pic);
        }
        if status != api::SUCCESS && status != api::ERR_NEED_MORE_INPUT {
            // SAFETY: undoes the map above.
            unsafe { (self.f.unmap)(self.session, map.mapped_resource) };
            self.free.push(surface);
            return Err(status_error("encoding a picture", status, Some(&self.f), self.session));
        }
        self.queued.push_back(InFlight { surface, mapped: map.mapped_resource, token });
        if status == api::SUCCESS {
            // The encoder has begun to give output for what it was holding.
            self.ready.append(&mut self.queued);
        }
        self.collect(out, false)
    }

    fn encode(&self, pic: &mut api::PicParams) -> Status {
        // SAFETY: valid session; `pic` is a live local of the size the header says.
        unsafe { (self.f.encode)(self.session, pic) }
    }

    /// Takes the compressed form of finished pictures. While the stream runs this waits until the
    /// encoder holds `async_depth` pictures (FFmpeg's rule): an encoder that looks ahead has output for
    /// a picture only once it has seen enough of the pictures after it, and asking sooner for the
    /// output of the second picture than the driver has it is refused ("invalid parameter"). With
    /// `flush` everything is taken (the encoder has been told the stream is over).
    fn collect(&mut self, out: &mut Vec<EncodedVideo>, flush: bool) -> Result<()> {
        while !self.ready.is_empty() && (flush || self.ready.len() + self.queued.len() >= self.async_depth) {
            let done = self.ready.pop_front().expect("checked above");
            let mut lock: api::LockBitstream = zeroed();
            lock.version = self.v.lock_bitstream;
            lock.output_bitstream = self.outputs[done.surface];
            // SAFETY: valid session and output buffer; waits until the picture is finished.
            let status = unsafe { (self.f.lock)(self.session, &mut lock) };
            if status != api::SUCCESS {
                debug(&format!(
                    "NVENC: lock failed on surface {} (token {}); {} ready after it, {} queued, {} free, frame {}",
                    done.surface,
                    done.token,
                    self.ready.len(),
                    self.queued.len(),
                    self.free.len(),
                    self.frame_idx
                ));
                return Err(status_error("collecting a finished picture", status, Some(&self.f), self.session));
            }
            let data = if lock.bitstream_buffer_ptr.is_null() {
                Vec::new()
            } else {
                // SAFETY: the driver says `bitstream_size_in_bytes` bytes are readable at that address until unlocked.
                unsafe { std::slice::from_raw_parts(lock.bitstream_buffer_ptr as *const u8, lock.bitstream_size_in_bytes as usize) }.to_vec()
            };
            let (pts, kind) = (ticks(lock.output_time_stamp as i64, self.params.fps), lock.picture_type);
            // SAFETY: pairs with the lock above; then the input can be let go.
            unsafe {
                (self.f.unlock)(self.session, self.outputs[done.surface]);
                (self.f.unmap)(self.session, done.mapped);
            }
            self.free.push(done.surface);
            self.released.push(done.token);
            let dts = self.dts.picture_out();
            out.push(EncodedVideo { data, pts, dts, clean_point: kind == api::PIC_TYPE_IDR });
        }
        Ok(())
    }

    /// Tells the encoder no more pictures are coming and collects everything it was holding.
    pub fn finish(&mut self, out: &mut Vec<EncodedVideo>) -> Result<()> {
        let mut pic: api::PicParams = zeroed();
        pic.version = self.v.pic_params;
        pic.encode_pic_flags = api::PIC_FLAG_EOS;
        let status = self.encode(&mut pic);
        if status != api::SUCCESS && status != api::ERR_NEED_MORE_INPUT {
            return Err(status_error("finishing the stream", status, Some(&self.f), self.session));
        }
        self.ready.append(&mut self.queued);
        self.collect(out, true)
    }

    /// Moves the names of the pictures the encoder is done with into `into`.
    pub fn take_released(&mut self, into: &mut Vec<usize>) {
        into.append(&mut self.released);
    }

    /// Pictures the encoder is holding (given and not yet collected).
    pub fn in_flight(&self) -> usize {
        self.queued.len() + self.ready.len()
    }
}

impl Drop for Nvenc {
    fn drop(&mut self) {
        // SAFETY: tears down what was created above, in the reverse order; each handle is released once.
        unsafe {
            for f in self.queued.drain(..).chain(self.ready.drain(..)) {
                (self.f.unmap)(self.session, f.mapped);
            }
            for r in self.registered.drain(..) {
                (self.f.unregister)(self.session, r.handle);
            }
            for &out in &self.outputs {
                (self.f.destroy_bitstream)(self.session, out);
            }
            (self.f.destroy)(self.session);
        }
    }
}

/// The frame number a time (in 100 ns units) is, at `fps` frames a second: what the encoder is given.
fn frame_number(pts: i64, fps: u32) -> i64 {
    (pts * i64::from(fps) + 5_000_000).div_euclid(10_000_000)
}

/// The time (in 100 ns units) of a frame number: `frame_number`'s way back.
fn ticks(frame: i64, fps: u32) -> i64 {
    frame * 10_000_000 / i64::from(fps.max(1))
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

// ---- trying a set of settings for real ----

/// A small NV12 picture of `width` x `height` made of a moving-looking gradient (`phase` shifts it),
/// in a texture the encoder can take.
pub fn test_picture(device: &ID3D11Device, width: u32, height: u32, phase: u32) -> Result<ID3D11Texture2D> {
    let (w, h) = (width as usize, height as usize);
    let mut data = vec![0u8; w * h * 3 / 2];
    for y in 0..h {
        for x in 0..w {
            data[y * w + x] = (16 + ((x as u32 + phase * 7) * 3 + y as u32) % 200) as u8;
        }
    }
    for (i, b) in data[w * h..].iter_mut().enumerate() {
        *b = 100 + ((i as u32 + phase) % 56) as u8;
    }
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        ..Default::default()
    };
    let init = D3D11_SUBRESOURCE_DATA { pSysMem: data.as_ptr() as *const _, SysMemPitch: width, SysMemSlicePitch: 0 };
    let mut texture = None;
    // SAFETY: `data` holds the whole NV12 picture and is copied by the call.
    unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut texture)).context("Couldn't make a test picture on the graphics card")? };
    texture.ok_or_else(|| Error::new("Couldn't make a test picture on the graphics card."))
}

/// Encodes a short clip of tiny pictures with `params` and checks that what comes out is a stream:
/// the right number of pictures, a first keyframe with parameter sets, and B-frames if they were
/// asked for. This is how the probe (and the start of a stream) find out whether the card really
/// takes a set of settings, not just whether the driver is installed.
pub fn self_test(device: &ID3D11Device, params: &NvencParams) -> Result<()> {
    let (w, h) = (320, 192);
    let mut session = Nvenc::open(device, w, h, params)?;
    let pictures = [test_picture(device, w, h, 0)?, test_picture(device, w, h, 3)?, test_picture(device, w, h, 9)?];
    let count = params.lookahead as usize + params.bframes as usize + 8;
    let mut out = Vec::new();
    for i in 0..count {
        session.feed(&pictures[i % pictures.len()], i, i as i64 * 166_667, false, &mut out)?;
    }
    session.finish(&mut out)?;
    if out.len() != count {
        return Err(Error::new(format!("The NVIDIA encoder returned {} pictures for {count}.", out.len())));
    }
    let first = crate::h264::annexb_to_avcc(&out[0].data);
    if !(first.keyframe && first.sps.is_some() && first.pps.is_some()) {
        return Err(Error::new("The NVIDIA encoder's first picture isn't a keyframe with its parameter sets."));
    }
    if params.bframes > 0 && !out.iter().any(|e| crate::h264::is_b_picture(&e.data)) {
        // Not an error: the encoder is free to choose none for a plain picture. Noted for the log.
        debug("NVENC self test: no B-pictures in the test clip");
    }
    let mut released = Vec::new();
    session.take_released(&mut released);
    if released.len() != count {
        return Err(Error::new("The NVIDIA encoder kept some pictures."));
    }
    Ok(())
}

/// Which of the attempts in `attempts` (see `tuning::attempts`) opens and encodes on this device,
/// first one wins. `None` when the card takes none.
pub fn first_working(device: &ID3D11Device, kbps: u32, fps: u32, keyframe_seconds: u32, attempts: &[(tuning::Tuning, u32)]) -> Option<(tuning::Tuning, u32)> {
    attempts.iter().copied().find(|&(tuning, bframes)| {
        let params = tuning::nvenc_params(tuning, kbps, fps, keyframe_seconds, bframes);
        match self_test(device, &params) {
            Ok(()) => true,
            Err(e) => {
                debug(&format!("NVENC {} with {bframes} B-frames: {e}", tuning.name()));
                false
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_driver_is_told_apart_from_a_newer_one() {
        assert_eq!(check_version(0xd1).unwrap(), api::LATEST);
        assert_eq!(check_version(0xd2).unwrap(), api::LATEST);
        assert_eq!(check_version(0xe0).unwrap(), api::LATEST);
        // 13.0 has the same structures, with its own version numbers in them.
        assert_eq!(check_version(0xd0).unwrap(), api::Versions::for_minor(0));
        let err = check_version(0xc2).unwrap_err();
        assert!(err.message().contains("12.2") && err.message().contains("13.0"), "{err}");
    }

    #[test]
    fn time_stamps_make_the_round_trip_through_frame_numbers() {
        for fps in [30, 60] {
            for n in (0..100_000i64).step_by(7) {
                let pts = n * 10_000_000 / i64::from(fps);
                assert_eq!(frame_number(pts, fps), n, "{n} at {fps}");
                assert_eq!(ticks(frame_number(pts, fps), fps), pts);
            }
        }
        assert_eq!(frame_number(0, 60), 0);
        assert_eq!(frame_number(166_666, 60), 1);
    }

    #[test]
    fn the_dar_is_the_reduced_shape() {
        assert_eq!(gcd(1920, 1080), 120);
        assert_eq!((1920 / 120, 1080 / 120), (16, 9));
        assert_eq!(gcd(7, 0), 7);
    }
}
