//! NVIDIA's NVENC API, as far as the engine uses it: hand-written `#[repr(C)]` declarations, not a
//! copy of NVIDIA's header. The layouts are those of `nvEncodeAPI.h` from FFmpeg's `nv-codec-headers`
//! (MIT licensed), API version 13.1, for 64-bit Windows. Every struct has its size checked against
//! the header when it is compiled, and so do the offsets of the fields that are used, so a mistake
//! here is a build error and not a driver crash.
//!
//! Every structure the engine uses has the same size and layout in API 13.0 as in 13.1 (checked by
//! compiling both versions of the header), so a driver that speaks 13.0 is told 13.0 and one that
//! speaks 13.1 or later is told 13.1: the version numbers in each structure follow what the driver
//! answers to `NvEncodeAPIGetMaxSupportedVersion` ([`Versions::for_driver`]). Older drivers (12.x)
//! have different layouts and are refused, and the engine uses Media Foundation instead.
//!
//! [`apply_params`] is the one piece of logic in this file: it writes the settings of `tuning.rs`
//! into the driver's configuration structure.

use crate::tuning::{BFrameRef, Multipass, NvencParams, Preset};
use std::ffi::c_void;
use std::mem::{offset_of, size_of};

pub const API_MAJOR: u32 = 13;
/// The newest minor version the layouts below are written for.
pub const API_MINOR: u32 = 1;
/// The oldest minor version of API 13 whose layouts are the same.
pub const API_MINOR_OLDEST: u32 = 0;

/// `NVENCAPI_STRUCT_VERSION(v)` for API 13.`minor`.
pub const fn struct_version(minor: u32, v: u32) -> u32 {
    (API_MAJOR | (minor << 24)) | (v << 16) | (0x7 << 28)
}

/// The version numbers to put in each structure (and to tell the driver) for one API version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Versions {
    /// `NVENCAPI_VERSION`: what the engine tells the driver it speaks.
    pub api: u32,
    pub function_list: u32,
    pub open_session_ex: u32,
    pub caps_param: u32,
    pub config: u32,
    pub initialize_params: u32,
    pub preset_config: u32,
    pub rc_params: u32,
    pub pic_params: u32,
    pub lock_bitstream: u32,
    pub create_bitstream_buffer: u32,
    pub register_resource: u32,
    pub map_input_resource: u32,
}

impl Versions {
    pub const fn for_minor(minor: u32) -> Versions {
        Versions {
            api: API_MAJOR | (minor << 24),
            function_list: struct_version(minor, 2),
            open_session_ex: struct_version(minor, 1),
            caps_param: struct_version(minor, 1),
            config: struct_version(minor, 9) | (1 << 31),
            initialize_params: struct_version(minor, 7) | (1 << 31),
            preset_config: struct_version(minor, 5) | (1 << 31),
            rc_params: struct_version(minor, 1),
            pic_params: struct_version(minor, 7) | (1 << 31),
            lock_bitstream: struct_version(minor, 2) | (1 << 31),
            create_bitstream_buffer: struct_version(minor, 1),
            register_resource: struct_version(minor, 5),
            map_input_resource: struct_version(minor, 4),
        }
    }

    /// The versions to speak to a driver whose `NvEncodeAPIGetMaxSupportedVersion` said `max`
    /// (`(major << 4) | minor`), or `None` if it is older than 13.0.
    pub const fn for_driver(max: u32) -> Option<Versions> {
        if max >= (API_MAJOR << 4) | API_MINOR {
            Some(Versions::for_minor(API_MINOR))
        } else if max >= (API_MAJOR << 4) | API_MINOR_OLDEST {
            Some(Versions::for_minor(API_MINOR_OLDEST))
        } else {
            None
        }
    }
}

/// The newest.
pub const LATEST: Versions = Versions::for_minor(API_MINOR);

// ---- status codes (NVENCSTATUS) ----

pub type Status = i32;
pub const SUCCESS: Status = 0;
pub const ERR_INVALID_VERSION: Status = 15;
pub const ERR_NEED_MORE_INPUT: Status = 17;
pub const ERR_ENCODER_BUSY: Status = 18;

/// A plain sentence for the status codes a person could meet, for the log.
pub fn status_name(status: Status) -> &'static str {
    match status {
        0 => "success",
        1 => "no encode device",
        2 => "unsupported device",
        3 => "invalid encoder device",
        4 => "invalid device",
        5 => "device does not exist",
        6 => "invalid pointer",
        7 => "invalid event",
        8 => "invalid parameter",
        9 => "invalid call",
        10 => "out of memory",
        11 => "encoder not initialized",
        12 => "unsupported parameter",
        13 => "lock busy",
        14 => "not enough buffer",
        15 => "invalid version",
        16 => "map failed",
        17 => "need more input",
        18 => "encoder busy",
        19 => "event not registered",
        20 => "generic error",
        21 => "incompatible client key",
        22 => "unimplemented",
        23 => "resource register failed",
        24 => "resource not registered",
        25 => "resource not mapped",
        26 => "need more output",
        _ => "unknown error",
    }
}

// ---- GUIDs ----

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Guid {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

const fn guid(data1: u32, data2: u16, data3: u16, data4: [u8; 8]) -> Guid {
    Guid { data1, data2, data3, data4 }
}

pub const CODEC_H264: Guid = guid(0x6bc82762, 0x4e63, 0x4ca4, [0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf]);
pub const PROFILE_H264_HIGH: Guid = guid(0xe7cbc309, 0x4f7a, 0x4b89, [0xaf, 0x2a, 0xd5, 0x37, 0xc9, 0x2b, 0xe3, 0x10]);
pub const PRESET_P5: Guid = guid(0x21c6e6b4, 0x297a, 0x4cba, [0x99, 0x8f, 0xb6, 0xcb, 0xde, 0x72, 0xad, 0xe3]);
pub const PRESET_P6: Guid = guid(0x8e75c279, 0x6299, 0x4ab6, [0x83, 0x02, 0x0b, 0x21, 0x5a, 0x33, 0x5c, 0xf5]);

// ---- enumerations (their values in the header) ----

pub const DEVICE_TYPE_DIRECTX: u32 = 0;
pub const INPUT_RESOURCE_TYPE_DIRECTX: u32 = 0;
pub const BUFFER_FORMAT_NV12: u32 = 1;
pub const TUNING_INFO_HIGH_QUALITY: u32 = 1;
pub const RC_CBR: u32 = 2;
pub const MULTI_PASS_DISABLED: u32 = 0;
pub const MULTI_PASS_QUARTER_RESOLUTION: u32 = 1;
pub const B_FRAME_REF_DISABLED: u32 = 0;
pub const B_FRAME_REF_MIDDLE: u32 = 2;
pub const ENTROPY_CABAC: u32 = 1;
pub const FRAME_FIELD_MODE_FRAME: u32 = 1;
pub const PIC_STRUCT_FRAME: u32 = 1;
pub const PIC_FLAG_FORCE_IDR: u32 = 0x2;
pub const PIC_FLAG_OUTPUT_SPSPPS: u32 = 0x4;
pub const PIC_FLAG_EOS: u32 = 0x8;
pub const PIC_TYPE_IDR: u32 = 3;
pub const PIC_TYPE_B: u32 = 1;

/// `NV_ENC_CAPS` values the engine asks about.
pub mod caps {
    pub const NUM_MAX_BFRAMES: u32 = 0;
    pub const SUPPORT_LOOKAHEAD: u32 = 37;
    pub const SUPPORT_TEMPORAL_AQ: u32 = 38;
    pub const SUPPORT_BFRAME_REF_MODE: u32 = 43;
    pub const WIDTH_MAX: u32 = 16;
    pub const HEIGHT_MAX: u32 = 17;
}

// ---- structures ----

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Qp {
    pub inter_p: u32,
    pub inter_b: u32,
    pub intra: u32,
}

/// Bits of `RcParams::flags`.
pub mod rc_flags {
    pub const ENABLE_AQ: u32 = 1 << 3;
    pub const ENABLE_LOOKAHEAD: u32 = 1 << 5;
    pub const DISABLE_IADAPT: u32 = 1 << 6;
    pub const DISABLE_BADAPT: u32 = 1 << 7;
    pub const ENABLE_TEMPORAL_AQ: u32 = 1 << 8;
    pub const ZERO_REORDER_DELAY: u32 = 1 << 9;
}

/// `NV_ENC_RC_PARAMS`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RcParams {
    pub version: u32,
    pub rate_control_mode: u32,
    pub const_qp: Qp,
    pub average_bit_rate: u32,
    pub max_bit_rate: u32,
    pub vbv_buffer_size: u32,
    pub vbv_initial_delay: u32,
    /// The bit fields (see [`rc_flags`]).
    pub flags: u32,
    pub min_qp: Qp,
    pub max_qp: Qp,
    pub initial_rc_qp: Qp,
    pub temporal_layer_idx_mask: u32,
    pub temporal_layer_qp: [u8; 8],
    pub target_quality: u8,
    pub target_quality_lsb: u8,
    pub lookahead_depth: u16,
    pub low_delay_key_frame_scale: u8,
    pub y_dc_qp_index_offset: i8,
    pub u_dc_qp_index_offset: i8,
    pub v_dc_qp_index_offset: i8,
    pub qp_map_mode: u32,
    pub multi_pass: u32,
    pub alpha_layer_bitrate_ratio: u32,
    pub cb_qp_index_offset: i8,
    pub cr_qp_index_offset: i8,
    pub reserved2: u16,
    pub lookahead_level: u32,
    pub view_bitrate_ratios: [u8; 7],
    pub reserved3: u8,
    pub reserved1: u32,
}

/// `NV_ENC_CONFIG_H264_VUI_PARAMETERS`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct H264Vui {
    pub overscan_info_present_flag: u32,
    pub overscan_info: u32,
    pub video_signal_type_present_flag: u32,
    pub video_format: u32,
    pub video_full_range_flag: u32,
    pub colour_description_present_flag: u32,
    pub colour_primaries: u32,
    pub transfer_characteristics: u32,
    pub colour_matrix: u32,
    pub chroma_sample_location_flag: u32,
    pub chroma_sample_location_top: u32,
    pub chroma_sample_location_bot: u32,
    pub bitstream_restriction_flag: u32,
    pub timing_info_present_flag: u32,
    pub num_unit_in_ticks: u32,
    pub time_scale: u32,
    pub reserved: [u32; 12],
}

/// Bits of `ConfigH264::flags`.
pub mod h264_flags {
    pub const OUTPUT_BUFFERING_PERIOD_SEI: u32 = 1 << 4;
    pub const OUTPUT_PICTURE_TIMING_SEI: u32 = 1 << 5;
    pub const OUTPUT_AUD: u32 = 1 << 6;
    pub const DISABLE_SPSPPS: u32 = 1 << 7;
    pub const REPEAT_SPSPPS: u32 = 1 << 12;
    pub const ENABLE_FILLER_DATA_INSERTION: u32 = 1 << 17;
}

/// `NV_ENC_CONFIG_H264`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ConfigH264 {
    pub flags: u32,
    pub level: u32,
    pub idr_period: u32,
    pub separate_colour_plane_flag: u32,
    pub disable_deblocking_filter_idc: u32,
    pub num_temporal_layers: u32,
    pub sps_id: u32,
    pub pps_id: u32,
    pub adaptive_transform_mode: u32,
    pub fmo_mode: u32,
    pub bdirect_mode: u32,
    pub entropy_coding_mode: u32,
    pub stereo_mode: u32,
    pub intra_refresh_period: u32,
    pub intra_refresh_cnt: u32,
    pub max_num_ref_frames: u32,
    pub slice_mode: u32,
    pub slice_mode_data: u32,
    pub vui: H264Vui,
    pub ltr_num_frames: u32,
    pub ltr_trust_mode: u32,
    pub chroma_format_idc: u32,
    pub max_temporal_layers: u32,
    pub use_b_frames_as_ref: u32,
    pub num_ref_l0: u32,
    pub num_ref_l1: u32,
    pub output_bit_depth: u32,
    pub input_bit_depth: u32,
    pub tf_level: u32,
    pub reserved1: [u32; 264],
    pub reserved2: [*mut c_void; 64],
}

/// `NV_ENC_CODEC_CONFIG`: only the H.264 member is used.
#[repr(C)]
#[derive(Clone, Copy)]
pub union CodecConfig {
    pub h264: ConfigH264,
    pub reserved: [u32; 448],
}

/// `NV_ENC_CONFIG`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Config {
    pub version: u32,
    pub profile_guid: Guid,
    pub gop_length: u32,
    pub frame_interval_p: i32,
    pub mono_chrome_encoding: u32,
    pub frame_field_mode: u32,
    pub mv_precision: u32,
    pub rc: RcParams,
    pub codec: CodecConfig,
    pub reserved: [u32; 278],
    pub reserved2: [*mut c_void; 64],
}

/// `NV_ENC_PRESET_CONFIG`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PresetConfig {
    pub version: u32,
    pub reserved: u32,
    pub config: Config,
    pub reserved1: [u32; 256],
    pub reserved2: [*mut c_void; 64],
}

/// `NV_ENC_INITIALIZE_PARAMS`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct InitializeParams {
    pub version: u32,
    pub encode_guid: Guid,
    pub preset_guid: Guid,
    pub encode_width: u32,
    pub encode_height: u32,
    pub dar_width: u32,
    pub dar_height: u32,
    pub frame_rate_num: u32,
    pub frame_rate_den: u32,
    pub enable_encode_async: u32,
    pub enable_ptd: u32,
    /// The bit fields: none are used.
    pub flags: u32,
    pub priv_data_size: u32,
    pub reserved: u32,
    pub priv_data: *mut c_void,
    pub encode_config: *mut Config,
    pub max_encode_width: u32,
    pub max_encode_height: u32,
    pub max_me_hint_counts_per_block: [u32; 8],
    pub tuning_info: u32,
    pub buffer_format: u32,
    pub num_state_buffers: u32,
    pub output_stats_level: u32,
    pub reserved1: [u32; 284],
    pub reserved2: [*mut c_void; 64],
}

/// `NV_ENC_PIC_PARAMS_H264`: only the slice settings are used.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PicParamsH264 {
    pub head: [u32; 12],
    pub slice_mode: u32,
    pub slice_mode_data: u32,
    pub tail: [u64; 185],
}

/// `NV_ENC_CODEC_PIC_PARAMS`.
#[repr(C)]
#[derive(Clone, Copy)]
pub union CodecPicParams {
    pub h264: PicParamsH264,
    pub reserved: [u32; 386],
}

/// `NV_ENC_PIC_PARAMS`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PicParams {
    pub version: u32,
    pub input_width: u32,
    pub input_height: u32,
    pub input_pitch: u32,
    pub encode_pic_flags: u32,
    pub frame_idx: u32,
    pub input_time_stamp: u64,
    pub input_duration: u64,
    pub input_buffer: *mut c_void,
    pub output_bitstream: *mut c_void,
    pub completion_event: *mut c_void,
    pub buffer_fmt: u32,
    pub picture_struct: u32,
    pub picture_type: u32,
    pub pad: u32,
    pub codec_pic_params: CodecPicParams,
    pub tail: [u64; 217],
}

/// `NV_ENC_LOCK_BITSTREAM`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct LockBitstream {
    pub version: u32,
    /// The bit fields: bit 0 is `doNotWait`.
    pub flags: u32,
    pub output_bitstream: *mut c_void,
    pub slice_offsets: *mut u32,
    pub frame_idx: u32,
    pub hw_encode_status: u32,
    pub num_slices: u32,
    pub bitstream_size_in_bytes: u32,
    pub output_time_stamp: u64,
    pub output_duration: u64,
    pub bitstream_buffer_ptr: *mut c_void,
    pub picture_type: u32,
    pub picture_struct: u32,
    pub frame_avg_qp: u32,
    pub frame_satd: u32,
    pub tail: [u64; 183],
}

/// `NV_ENC_MAP_INPUT_RESOURCE`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MapInputResource {
    pub version: u32,
    pub sub_resource_index: u32,
    pub input_resource: *mut c_void,
    pub registered_resource: *mut c_void,
    pub mapped_resource: *mut c_void,
    pub mapped_buffer_fmt: u32,
    pub tail: [u32; 377],
}

/// `NV_ENC_REGISTER_RESOURCE`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RegisterResource {
    pub version: u32,
    pub resource_type: u32,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub sub_resource_index: u32,
    pub resource_to_register: *mut c_void,
    pub registered_resource: *mut c_void,
    pub buffer_format: u32,
    pub buffer_usage: u32,
    pub input_fence_point: *mut c_void,
    pub tail: [u64; 185],
}

/// `NV_ENC_CREATE_BITSTREAM_BUFFER`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CreateBitstreamBuffer {
    pub version: u32,
    pub size: u32,
    pub memory_heap: u32,
    pub reserved: u32,
    pub bitstream_buffer: *mut c_void,
    pub bitstream_buffer_ptr: *mut c_void,
    pub tail: [u64; 93],
}

/// `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct OpenSessionExParams {
    pub version: u32,
    pub device_type: u32,
    pub device: *mut c_void,
    pub reserved: *mut c_void,
    pub api_version: u32,
    pub tail: [u32; 381],
}

/// `NV_ENC_CAPS_PARAM`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CapsParam {
    pub version: u32,
    pub caps_to_query: u32,
    pub reserved: [u32; 62],
}

/// `NV_ENCODE_API_FUNCTION_LIST`: the driver fills in function pointers; the engine reads the ones
/// it needs by position (see [`slot`]).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FunctionList {
    pub version: u32,
    pub reserved: u32,
    pub slots: [usize; 318],
}

/// Positions in [`FunctionList::slots`] of the functions used.
pub mod slot {
    pub const GET_ENCODE_CAPS: usize = 7;
    pub const INITIALIZE_ENCODER: usize = 11;
    pub const CREATE_BITSTREAM_BUFFER: usize = 14;
    pub const DESTROY_BITSTREAM_BUFFER: usize = 15;
    pub const ENCODE_PICTURE: usize = 16;
    pub const LOCK_BITSTREAM: usize = 17;
    pub const UNLOCK_BITSTREAM: usize = 18;
    pub const MAP_INPUT_RESOURCE: usize = 25;
    pub const UNMAP_INPUT_RESOURCE: usize = 26;
    pub const DESTROY_ENCODER: usize = 27;
    pub const OPEN_ENCODE_SESSION_EX: usize = 29;
    pub const REGISTER_RESOURCE: usize = 30;
    pub const UNREGISTER_RESOURCE: usize = 31;
    pub const GET_LAST_ERROR_STRING: usize = 37;
    pub const GET_ENCODE_PRESET_CONFIG_EX: usize = 39;
}

/// A zero-filled structure, which is how every one of these is meant to start.
pub fn zeroed<T: Copy>() -> T {
    // SAFETY: only used with the plain-data structures above, for which all-zero bytes (null
    // pointers, zero numbers) is a valid value and what the header says to pass for "unused".
    unsafe { std::mem::zeroed() }
}

// ---- sizes and offsets, as the header has them for 64-bit Windows ----

const _: () = {
    assert!(size_of::<Guid>() == 16);
    assert!(size_of::<Qp>() == 12);
    assert!(size_of::<RcParams>() == 128);
    assert!(size_of::<H264Vui>() == 112);
    assert!(size_of::<ConfigH264>() == 1792);
    assert!(size_of::<CodecConfig>() == 1792);
    assert!(size_of::<Config>() == 3584);
    assert!(size_of::<PresetConfig>() == 5128);
    assert!(size_of::<InitializeParams>() == 1800);
    assert!(size_of::<PicParamsH264>() == 1536);
    assert!(size_of::<CodecPicParams>() == 1544);
    assert!(size_of::<PicParams>() == 3360);
    assert!(size_of::<LockBitstream>() == 1544);
    assert!(size_of::<MapInputResource>() == 1544);
    assert!(size_of::<RegisterResource>() == 1536);
    assert!(size_of::<CreateBitstreamBuffer>() == 776);
    assert!(size_of::<OpenSessionExParams>() == 1552);
    assert!(size_of::<CapsParam>() == 256);
    assert!(size_of::<FunctionList>() == 2552);

    assert!(offset_of!(RcParams, rate_control_mode) == 4);
    assert!(offset_of!(RcParams, average_bit_rate) == 20);
    assert!(offset_of!(RcParams, max_bit_rate) == 24);
    assert!(offset_of!(RcParams, vbv_buffer_size) == 28);
    assert!(offset_of!(RcParams, vbv_initial_delay) == 32);
    assert!(offset_of!(RcParams, flags) == 36);
    assert!(offset_of!(RcParams, min_qp) == 40);
    assert!(offset_of!(RcParams, initial_rc_qp) == 64);
    assert!(offset_of!(RcParams, target_quality) == 88);
    assert!(offset_of!(RcParams, lookahead_depth) == 90);
    assert!(offset_of!(RcParams, qp_map_mode) == 96);
    assert!(offset_of!(RcParams, multi_pass) == 100);
    assert!(offset_of!(RcParams, cb_qp_index_offset) == 108);
    assert!(offset_of!(RcParams, lookahead_level) == 112);
    assert!(offset_of!(RcParams, reserved1) == 124);

    assert!(offset_of!(ConfigH264, level) == 4);
    assert!(offset_of!(ConfigH264, idr_period) == 8);
    assert!(offset_of!(ConfigH264, num_temporal_layers) == 20);
    assert!(offset_of!(ConfigH264, adaptive_transform_mode) == 32);
    assert!(offset_of!(ConfigH264, entropy_coding_mode) == 44);
    assert!(offset_of!(ConfigH264, max_num_ref_frames) == 60);
    assert!(offset_of!(ConfigH264, slice_mode) == 64);
    assert!(offset_of!(ConfigH264, vui) == 72);
    assert!(offset_of!(ConfigH264, ltr_num_frames) == 184);
    assert!(offset_of!(ConfigH264, chroma_format_idc) == 192);
    assert!(offset_of!(ConfigH264, use_b_frames_as_ref) == 200);
    assert!(offset_of!(ConfigH264, num_ref_l0) == 204);
    assert!(offset_of!(ConfigH264, tf_level) == 220);
    assert!(offset_of!(ConfigH264, reserved1) == 224);
    assert!(offset_of!(ConfigH264, reserved2) == 1280);

    assert!(offset_of!(Config, profile_guid) == 4);
    assert!(offset_of!(Config, gop_length) == 20);
    assert!(offset_of!(Config, frame_interval_p) == 24);
    assert!(offset_of!(Config, frame_field_mode) == 32);
    assert!(offset_of!(Config, mv_precision) == 36);
    assert!(offset_of!(Config, rc) == 40);
    assert!(offset_of!(Config, codec) == 168);
    assert!(offset_of!(Config, reserved) == 1960);
    assert!(offset_of!(Config, reserved2) == 3072);

    assert!(offset_of!(PresetConfig, config) == 8);
    assert!(offset_of!(PresetConfig, reserved1) == 3592);
    assert!(offset_of!(PresetConfig, reserved2) == 4616);

    assert!(offset_of!(InitializeParams, encode_guid) == 4);
    assert!(offset_of!(InitializeParams, preset_guid) == 20);
    assert!(offset_of!(InitializeParams, encode_width) == 36);
    assert!(offset_of!(InitializeParams, dar_width) == 44);
    assert!(offset_of!(InitializeParams, frame_rate_num) == 52);
    assert!(offset_of!(InitializeParams, enable_encode_async) == 60);
    assert!(offset_of!(InitializeParams, enable_ptd) == 64);
    assert!(offset_of!(InitializeParams, flags) == 68);
    assert!(offset_of!(InitializeParams, priv_data_size) == 72);
    assert!(offset_of!(InitializeParams, priv_data) == 80);
    assert!(offset_of!(InitializeParams, encode_config) == 88);
    assert!(offset_of!(InitializeParams, max_encode_width) == 96);
    assert!(offset_of!(InitializeParams, max_me_hint_counts_per_block) == 104);
    assert!(offset_of!(InitializeParams, tuning_info) == 136);
    assert!(offset_of!(InitializeParams, buffer_format) == 140);
    assert!(offset_of!(InitializeParams, output_stats_level) == 148);
    assert!(offset_of!(InitializeParams, reserved1) == 152);
    assert!(offset_of!(InitializeParams, reserved2) == 1288);

    assert!(offset_of!(PicParamsH264, slice_mode) == 48);
    assert!(offset_of!(PicParams, input_width) == 4);
    assert!(offset_of!(PicParams, encode_pic_flags) == 16);
    assert!(offset_of!(PicParams, frame_idx) == 20);
    assert!(offset_of!(PicParams, input_time_stamp) == 24);
    assert!(offset_of!(PicParams, input_duration) == 32);
    assert!(offset_of!(PicParams, input_buffer) == 40);
    assert!(offset_of!(PicParams, output_bitstream) == 48);
    assert!(offset_of!(PicParams, completion_event) == 56);
    assert!(offset_of!(PicParams, buffer_fmt) == 64);
    assert!(offset_of!(PicParams, picture_struct) == 68);
    assert!(offset_of!(PicParams, picture_type) == 72);
    assert!(offset_of!(PicParams, codec_pic_params) == 80);

    assert!(offset_of!(LockBitstream, output_bitstream) == 8);
    assert!(offset_of!(LockBitstream, frame_idx) == 24);
    assert!(offset_of!(LockBitstream, bitstream_size_in_bytes) == 36);
    assert!(offset_of!(LockBitstream, output_time_stamp) == 40);
    assert!(offset_of!(LockBitstream, output_duration) == 48);
    assert!(offset_of!(LockBitstream, bitstream_buffer_ptr) == 56);
    assert!(offset_of!(LockBitstream, picture_type) == 64);
    assert!(offset_of!(LockBitstream, frame_satd) == 76);

    assert!(offset_of!(MapInputResource, input_resource) == 8);
    assert!(offset_of!(MapInputResource, registered_resource) == 16);
    assert!(offset_of!(MapInputResource, mapped_resource) == 24);
    assert!(offset_of!(MapInputResource, mapped_buffer_fmt) == 32);

    assert!(offset_of!(RegisterResource, resource_type) == 4);
    assert!(offset_of!(RegisterResource, width) == 8);
    assert!(offset_of!(RegisterResource, pitch) == 16);
    assert!(offset_of!(RegisterResource, resource_to_register) == 24);
    assert!(offset_of!(RegisterResource, registered_resource) == 32);
    assert!(offset_of!(RegisterResource, buffer_format) == 40);
    assert!(offset_of!(RegisterResource, buffer_usage) == 44);
    assert!(offset_of!(RegisterResource, input_fence_point) == 48);

    assert!(offset_of!(CreateBitstreamBuffer, memory_heap) == 8);
    assert!(offset_of!(CreateBitstreamBuffer, bitstream_buffer) == 16);
    assert!(offset_of!(CreateBitstreamBuffer, bitstream_buffer_ptr) == 24);

    assert!(offset_of!(OpenSessionExParams, device_type) == 4);
    assert!(offset_of!(OpenSessionExParams, device) == 8);
    assert!(offset_of!(OpenSessionExParams, api_version) == 24);

    assert!(offset_of!(CapsParam, caps_to_query) == 4);
    assert!(offset_of!(FunctionList, slots) == 8);
};

// ---- writing the settings into the configuration ----

/// The H.264 part of a configuration.
pub fn h264(config: &mut Config) -> &mut ConfigH264 {
    // SAFETY: the H.264 member is the one this engine ever fills or reads; the union is plain data
    // of which every member is valid for any bytes.
    unsafe { &mut config.codec.h264 }
}

/// The preset GUID that goes with a [`Preset`].
pub fn preset_guid(preset: Preset) -> Guid {
    match preset {
        Preset::P5 => PRESET_P5,
        Preset::P6 => PRESET_P6,
    }
}

/// Puts `p` into `config` (which starts as the driver's own configuration for the preset, so what is
/// not set here is the preset's), the way FFmpeg's `h264_nvenc` fills it for the same options.
pub fn apply_params(config: &mut Config, p: &NvencParams, versions: &Versions) {
    config.version = versions.config;
    config.profile_guid = PROFILE_H264_HIGH;
    config.gop_length = p.gop;
    config.frame_interval_p = p.bframes as i32 + 1;
    config.frame_field_mode = FRAME_FIELD_MODE_FRAME;

    let rc = &mut config.rc;
    rc.rate_control_mode = RC_CBR;
    rc.average_bit_rate = p.bitrate;
    rc.max_bit_rate = p.max_bitrate;
    rc.vbv_buffer_size = p.vbv_buffer;
    rc.multi_pass = match p.multipass {
        Multipass::Disabled => MULTI_PASS_DISABLED,
        Multipass::QuarterResolution => MULTI_PASS_QUARTER_RESOLUTION,
    };
    let set = |flags: &mut u32, bit: u32, on: bool| {
        if on {
            *flags |= bit;
        } else {
            *flags &= !bit;
        }
    };
    set(&mut rc.flags, rc_flags::ENABLE_AQ, p.spatial_aq);
    set(&mut rc.flags, rc_flags::ENABLE_TEMPORAL_AQ, p.temporal_aq);
    set(&mut rc.flags, rc_flags::ENABLE_LOOKAHEAD, p.lookahead > 0);
    // Scene-cut and B-frame decisions stay adaptive, which is what look-ahead is for.
    set(&mut rc.flags, rc_flags::DISABLE_IADAPT | rc_flags::DISABLE_BADAPT, false);
    set(&mut rc.flags, rc_flags::ZERO_REORDER_DELAY, false);
    rc.lookahead_depth = p.lookahead as u16;

    let h = h264(config);
    h.idr_period = p.gop;
    // One slice per picture.
    h.slice_mode = 3;
    h.slice_mode_data = 1;
    // Every keyframe carries the parameter sets (the FLV header is built from them); no filler,
    // no access unit delimiters.
    set(&mut h.flags, h264_flags::REPEAT_SPSPPS | h264_flags::OUTPUT_PICTURE_TIMING_SEI, true);
    set(
        &mut h.flags,
        h264_flags::DISABLE_SPSPPS | h264_flags::OUTPUT_AUD | h264_flags::OUTPUT_BUFFERING_PERIOD_SEI | h264_flags::ENABLE_FILLER_DATA_INSERTION,
        false,
    );
    h.level = 0; // the driver picks the level
    h.entropy_coding_mode = ENTROPY_CABAC;
    h.chroma_format_idc = 1;
    h.use_b_frames_as_ref = match p.b_frame_ref {
        BFrameRef::Disabled => B_FRAME_REF_DISABLED,
        BFrameRef::Middle => B_FRAME_REF_MIDDLE,
    };
    // The picture is BT.709 limited range (what the video processor makes): say so, so every player agrees.
    h.vui.video_signal_type_present_flag = 1;
    h.vui.video_format = 5; // unspecified
    h.vui.video_full_range_flag = 0;
    h.vui.colour_description_present_flag = 1;
    h.vui.colour_primaries = 1;
    h.vui.transfer_characteristics = 1;
    h.vui.colour_matrix = 1;
    h.vui.bitstream_restriction_flag = 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tuning::{nvenc_params, Tuning};

    fn config_for(tuning: Tuning, bframes: u32) -> Config {
        let mut config: Config = zeroed();
        // A preset would have set these; the settings have to override them.
        config.rc.flags = rc_flags::ENABLE_AQ | rc_flags::DISABLE_IADAPT | rc_flags::DISABLE_BADAPT | rc_flags::ZERO_REORDER_DELAY;
        h264(&mut config).flags = h264_flags::DISABLE_SPSPPS | h264_flags::OUTPUT_AUD | h264_flags::ENABLE_FILLER_DATA_INSERTION;
        apply_params(&mut config, &nvenc_params(tuning, 6000, 60, 2, bframes), &LATEST);
        config
    }

    #[test]
    fn versions_are_the_ones_in_the_header() {
        // Computed by compiling the header at API 13.1 (nv-codec-headers master) and 13.0 (branch sdk/13.0).
        let v = LATEST;
        assert_eq!(v.api, 0x0100_000d);
        assert_eq!(v.config, 0xf109_000d);
        assert_eq!(v.initialize_params, 0xf107_000d);
        assert_eq!(v.pic_params, 0xf107_000d);
        assert_eq!(v.lock_bitstream, 0xf102_000d);
        assert_eq!(v.preset_config, 0xf105_000d);
        assert_eq!(v.rc_params, 0x7101_000d);
        assert_eq!(v.register_resource, 0x7105_000d);
        assert_eq!(v.map_input_resource, 0x7104_000d);
        assert_eq!(v.create_bitstream_buffer, 0x7101_000d);
        assert_eq!(v.open_session_ex, 0x7101_000d);
        assert_eq!(v.caps_param, 0x7101_000d);
        assert_eq!(v.function_list, 0x7102_000d);
        let old = Versions::for_minor(0);
        assert_eq!(old.api, 0x0000_000d);
        assert_eq!(old.config, 0xf009_000d);
        assert_eq!(old.initialize_params, 0xf007_000d);
        assert_eq!(old.pic_params, 0xf007_000d);
        assert_eq!(old.lock_bitstream, 0xf002_000d);
        assert_eq!(old.preset_config, 0xf005_000d);
        assert_eq!(old.register_resource, 0x7005_000d);
        assert_eq!(old.map_input_resource, 0x7004_000d);
        assert_eq!(old.function_list, 0x7002_000d);
    }

    #[test]
    fn the_versions_spoken_follow_what_the_driver_supports() {
        assert_eq!(Versions::for_driver(0xd1), Some(LATEST));
        // A driver for a later API still speaks 13.1.
        assert_eq!(Versions::for_driver(0xd2), Some(LATEST));
        assert_eq!(Versions::for_driver(0xe0), Some(LATEST));
        assert_eq!(Versions::for_driver(0xd0), Some(Versions::for_minor(0)));
        // 12.x has other structures.
        assert_eq!(Versions::for_driver(0xc2), None);
        assert_eq!(Versions::for_driver(0xc0), None);
        assert_eq!(Versions::for_driver(0), None);
    }

    #[test]
    fn the_bit_fields_are_where_the_header_has_them() {
        assert_eq!(rc_flags::ENABLE_AQ, 0x08);
        assert_eq!(rc_flags::ENABLE_LOOKAHEAD, 0x20);
        assert_eq!(rc_flags::DISABLE_IADAPT, 0x40);
        assert_eq!(rc_flags::DISABLE_BADAPT, 0x80);
        assert_eq!(rc_flags::ENABLE_TEMPORAL_AQ, 0x100);
        assert_eq!(rc_flags::ZERO_REORDER_DELAY, 0x200);
        assert_eq!(h264_flags::OUTPUT_BUFFERING_PERIOD_SEI, 0x10);
        assert_eq!(h264_flags::OUTPUT_PICTURE_TIMING_SEI, 0x20);
        assert_eq!(h264_flags::OUTPUT_AUD, 0x40);
        assert_eq!(h264_flags::DISABLE_SPSPPS, 0x80);
        assert_eq!(h264_flags::REPEAT_SPSPPS, 0x1000);
        assert_eq!(h264_flags::ENABLE_FILLER_DATA_INSERTION, 0x2_0000);
    }

    #[test]
    fn the_quality_configuration_has_every_value_ffmpeg_asks_for() {
        let c = config_for(Tuning::Quality, 2);
        assert_eq!(c.version, LATEST.config);
        assert_eq!(c.profile_guid, PROFILE_H264_HIGH);
        assert_eq!(c.gop_length, 120);
        assert_eq!(c.frame_interval_p, 3, "2 B-frames");
        assert_eq!(c.frame_field_mode, FRAME_FIELD_MODE_FRAME);
        let rc = &c.rc;
        assert_eq!(rc.rate_control_mode, RC_CBR);
        assert_eq!((rc.average_bit_rate, rc.max_bit_rate, rc.vbv_buffer_size), (6_000_000, 6_000_000, 12_000_000));
        assert_eq!(rc.multi_pass, MULTI_PASS_QUARTER_RESOLUTION);
        assert_eq!(rc.lookahead_depth, 20);
        let on = |bit: u32| rc.flags & bit != 0;
        assert!(on(rc_flags::ENABLE_TEMPORAL_AQ), "temporal AQ on");
        assert!(!on(rc_flags::ENABLE_AQ), "spatial AQ off");
        assert!(on(rc_flags::ENABLE_LOOKAHEAD));
        assert!(!on(rc_flags::DISABLE_IADAPT) && !on(rc_flags::DISABLE_BADAPT) && !on(rc_flags::ZERO_REORDER_DELAY));
        let mut c = c;
        let h = h264(&mut c);
        assert_eq!(h.idr_period, 120, "an IDR picture at every keyframe");
        assert_eq!(h.use_b_frames_as_ref, B_FRAME_REF_MIDDLE);
        assert_eq!(h.entropy_coding_mode, ENTROPY_CABAC);
        assert_eq!(h.chroma_format_idc, 1);
        assert_eq!((h.slice_mode, h.slice_mode_data), (3, 1));
        assert_eq!(h.flags & h264_flags::REPEAT_SPSPPS, h264_flags::REPEAT_SPSPPS);
        assert_eq!(h.flags & h264_flags::OUTPUT_PICTURE_TIMING_SEI, h264_flags::OUTPUT_PICTURE_TIMING_SEI);
        assert_eq!(h.flags & (h264_flags::DISABLE_SPSPPS | h264_flags::OUTPUT_AUD | h264_flags::ENABLE_FILLER_DATA_INSERTION), 0);
        assert_eq!(h.level, 0);
        let v = h.vui;
        assert_eq!((v.video_signal_type_present_flag, v.video_format, v.video_full_range_flag, v.colour_description_present_flag), (1, 5, 0, 1));
        assert_eq!((v.colour_primaries, v.transfer_characteristics, v.colour_matrix), (1, 1, 1));
        assert_eq!(v.bitstream_restriction_flag, 1);
    }

    #[test]
    fn the_safe_configuration_drops_what_older_cards_refuse() {
        let c = config_for(Tuning::Safe, 2);
        assert_eq!(c.frame_interval_p, 3);
        assert_eq!(c.rc.multi_pass, MULTI_PASS_DISABLED);
        assert_eq!(c.rc.lookahead_depth, 0);
        assert_eq!(c.rc.flags & (rc_flags::ENABLE_LOOKAHEAD | rc_flags::ENABLE_TEMPORAL_AQ | rc_flags::ENABLE_AQ), 0);
        let mut c = c;
        assert_eq!(h264(&mut c).use_b_frames_as_ref, B_FRAME_REF_DISABLED);
        assert_eq!(c.rc.rate_control_mode, RC_CBR);
        assert_eq!(c.rc.average_bit_rate, 6_000_000);
    }

    #[test]
    fn no_b_frames_is_an_i_and_p_interval_of_one() {
        assert_eq!(config_for(Tuning::Safe, 0).frame_interval_p, 1);
        assert_eq!(config_for(Tuning::Quality, 0).frame_interval_p, 1);
        assert_eq!(config_for(Tuning::Quality, 3).frame_interval_p, 4);
    }

    #[test]
    fn a_driver_that_speaks_13_0_gets_13_0_version_numbers_in_its_configuration() {
        let mut config: Config = zeroed();
        apply_params(&mut config, &nvenc_params(Tuning::Quality, 6000, 60, 2, 2), &Versions::for_minor(0));
        assert_eq!(config.version, 0xf009_000d);
        assert_eq!(config.rc.lookahead_depth, 20, "everything else is the same");
    }

    #[test]
    fn the_presets_are_p5_and_p6() {
        assert_eq!(preset_guid(Preset::P5), PRESET_P5);
        assert_eq!(preset_guid(Preset::P6), PRESET_P6);
        assert_ne!(PRESET_P5, PRESET_P6);
    }

    #[test]
    fn status_codes_have_names() {
        assert_eq!(status_name(SUCCESS), "success");
        assert_eq!(status_name(ERR_NEED_MORE_INPUT), "need more input");
        assert_eq!(status_name(ERR_INVALID_VERSION), "invalid version");
        assert_eq!(status_name(999), "unknown error");
    }

    #[test]
    fn a_zeroed_structure_is_all_zero() {
        let list: FunctionList = zeroed();
        assert!(list.slots.iter().all(|&s| s == 0));
        let pic: PicParams = zeroed();
        assert_eq!(pic.frame_idx, 0);
        assert!(pic.input_buffer.is_null());
    }
}
