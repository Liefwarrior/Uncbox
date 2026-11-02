//! H.264 as the encoder hands it over (Annex B: NAL units separated by `00 00 01` start codes) and
//! as FLV and RTMP want it (AVCC: each NAL unit behind a 4-byte length). The parameter sets (SPS and
//! PPS) are taken out of the stream and put in the one-time sequence header instead.

pub const NAL_SLICE: u8 = 1;
pub const NAL_IDR: u8 = 5;
pub const NAL_SEI: u8 = 6;
pub const NAL_SPS: u8 = 7;
pub const NAL_PPS: u8 = 8;
pub const NAL_AUD: u8 = 9;

/// The NAL units in an Annex B buffer, without their start codes (or the zero padding before them).
pub fn split_annexb(data: &[u8]) -> Vec<&[u8]> {
    // Positions just after each 00 00 01.
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut nals = Vec::with_capacity(starts.len());
    for (n, &start) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map_or(data.len(), |next| next - 3);
        // Zero bytes before the next start code belong to it (the 4-byte form), not to this unit.
        while end > start && data[end - 1] == 0 {
            end -= 1;
        }
        if end > start {
            nals.push(&data[start..end]);
        }
    }
    nals
}

pub fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map_or(0, |b| b & 0x1F)
}

/// 0 means no other picture depends on this one, so it can be thrown away first if the network is slow.
pub fn nal_ref_idc(nal: &[u8]) -> u8 {
    nal.first().map_or(0, |b| (b >> 5) & 3)
}

/// One picture, ready for FLV.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Picture {
    /// The NAL units behind 4-byte lengths, without parameter sets and access unit delimiters.
    pub avcc: Vec<u8>,
    /// The sequence and picture parameter sets found in this picture, if any.
    pub sps: Option<Vec<u8>>,
    pub pps: Option<Vec<u8>>,
    /// An IDR picture: decoding can start here.
    pub keyframe: bool,
    /// Whether other pictures are predicted from this one.
    pub reference: bool,
}

/// Converts one Annex B access unit (the encoder's output for one frame) for FLV.
pub fn annexb_to_avcc(data: &[u8]) -> Picture {
    let mut pic = Picture::default();
    for nal in split_annexb(data) {
        match nal_type(nal) {
            NAL_SPS => pic.sps = Some(nal.to_vec()),
            NAL_PPS => pic.pps = Some(nal.to_vec()),
            NAL_AUD => {}
            t => {
                if t == NAL_IDR {
                    pic.keyframe = true;
                }
                if (t == NAL_IDR || t == NAL_SLICE) && nal_ref_idc(nal) != 0 {
                    pic.reference = true;
                }
                pic.avcc.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                pic.avcc.extend_from_slice(nal);
            }
        }
    }
    pic
}

/// The `AVCDecoderConfigurationRecord`: what a player needs before the first picture (the FLV
/// "AVC sequence header"). Only for 8-bit 4:2:0, which is all the hardware encoders make here.
pub fn decoder_config(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut out = vec![1, sps.get(1).copied().unwrap_or(100), sps.get(2).copied().unwrap_or(0), sps.get(3).copied().unwrap_or(40), 0xFF, 0xE1];
    out.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    out.extend_from_slice(sps);
    out.push(1);
    out.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    out.extend_from_slice(pps);
    if matches!(sps.get(1), Some(100 | 110 | 122 | 144)) {
        // High profiles say the chroma format and bit depths too: 4:2:0, 8 bits, no extra SPS.
        out.extend_from_slice(&[0xFC | 1, 0xF8, 0xF8, 0]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: &[u8] = &[0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9, 0x40, 0x78, 0x02, 0x27, 0xE5, 0xC0, 0x44];
    const PPS: &[u8] = &[0x68, 0xEB, 0xE3, 0xCB, 0x22, 0xC0];
    const IDR: &[u8] = &[0x65, 0x88, 0x84, 0x00, 0x33, 0xFF];
    const P_FRAME: &[u8] = &[0x41, 0x9A, 0x24, 0x6C, 0x41];
    const B_FRAME: &[u8] = &[0x01, 0x9E, 0x11, 0x22];

    fn annexb(parts: &[(&[u8], &[u8])]) -> Vec<u8> {
        parts.iter().flat_map(|(code, nal)| code.iter().chain(nal.iter()).copied().collect::<Vec<u8>>()).collect()
    }

    #[test]
    fn splits_three_and_four_byte_start_codes() {
        let data = annexb(&[(&[0, 0, 0, 1], SPS), (&[0, 0, 1], PPS), (&[0, 0, 0, 1], IDR)]);
        assert_eq!(split_annexb(&data), vec![SPS, PPS, IDR]);
    }

    #[test]
    fn keeps_zero_bytes_inside_a_unit_and_drops_the_padding() {
        let inner: &[u8] = &[0x41, 0x00, 0x00, 0x03, 0x00, 0x05];
        let mut data = annexb(&[(&[0, 0, 0, 1], inner)]);
        data.extend_from_slice(&[0, 0]); // trailing zeros before the next start code
        data.extend_from_slice(&[0, 0, 1, 0x41, 0x01]);
        assert_eq!(split_annexb(&data), vec![inner, &[0x41, 0x01][..]]);
    }

    #[test]
    fn nothing_without_a_start_code() {
        assert!(split_annexb(&[1, 2, 3, 4]).is_empty());
        assert!(split_annexb(&[]).is_empty());
    }

    #[test]
    fn a_keyframe_gives_the_parameter_sets_and_a_length_prefixed_picture() {
        let aud: &[u8] = &[0x09, 0x10];
        let data = annexb(&[(&[0, 0, 0, 1], aud), (&[0, 0, 0, 1], SPS), (&[0, 0, 0, 1], PPS), (&[0, 0, 1], IDR)]);
        let pic = annexb_to_avcc(&data);
        assert!(pic.keyframe && pic.reference);
        assert_eq!(pic.sps.as_deref(), Some(SPS));
        assert_eq!(pic.pps.as_deref(), Some(PPS));
        let mut expected = (IDR.len() as u32).to_be_bytes().to_vec();
        expected.extend_from_slice(IDR);
        assert_eq!(pic.avcc, expected);
    }

    #[test]
    fn tells_reference_pictures_from_throwaway_ones() {
        let p = annexb_to_avcc(&annexb(&[(&[0, 0, 0, 1], P_FRAME)]));
        assert!(!p.keyframe && p.reference);
        assert!(p.sps.is_none());
        let b = annexb_to_avcc(&annexb(&[(&[0, 0, 0, 1], B_FRAME)]));
        assert!(!b.keyframe && !b.reference);
    }

    #[test]
    fn several_slices_of_one_picture_are_all_kept() {
        let data = annexb(&[(&[0, 0, 0, 1], IDR), (&[0, 0, 0, 1], &[0x65, 0x01, 0x02])]);
        let pic = annexb_to_avcc(&data);
        assert_eq!(pic.avcc.len(), 4 + IDR.len() + 4 + 3);
    }

    #[test]
    fn the_decoder_config_holds_both_sets() {
        let cfg = decoder_config(SPS, PPS);
        assert_eq!(&cfg[..6], &[1, 0x64, 0x00, 0x28, 0xFF, 0xE1]);
        assert_eq!(u16::from_be_bytes([cfg[6], cfg[7]]) as usize, SPS.len());
        assert_eq!(&cfg[8..8 + SPS.len()], SPS);
        let at = 8 + SPS.len();
        assert_eq!(cfg[at], 1);
        assert_eq!(u16::from_be_bytes([cfg[at + 1], cfg[at + 2]]) as usize, PPS.len());
        assert_eq!(&cfg[at + 3..at + 3 + PPS.len()], PPS);
        // High profile adds the chroma format and bit depth bytes.
        assert_eq!(&cfg[at + 3 + PPS.len()..], &[0xFD, 0xF8, 0xF8, 0]);
    }

    #[test]
    fn main_profile_has_no_extension() {
        let main_sps = [0x67, 0x4D, 0x40, 0x1F, 0x01];
        let cfg = decoder_config(&main_sps, PPS);
        assert_eq!(cfg.len(), 6 + 2 + main_sps.len() + 1 + 2 + PPS.len());
    }
}
