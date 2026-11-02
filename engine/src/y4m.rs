//! Reading a Y4M file (YUV4MPEG2): raw, uncompressed video that FFmpeg writes and reads. This is for
//! testing and tooling only: with it the engine can encode a clip instead of the screen, so its
//! picture can be compared with FFmpeg's on the very same frames.
//!
//! 8-bit 4:2:0 and 4:4:4 are read (what almost every clip is once FFmpeg has turned it into raw
//! video). Each picture comes out as NV12, the layout the graphics card's video processor and the
//! encoders take: all the brightness values, then the two colour planes woven together.

use crate::error::{Error, Result};
use std::io::{BufRead, Read};

/// How the colour planes of the file are sampled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chroma {
    /// Colour at half the width and half the height (nearly all video).
    C420,
    /// Colour at full size.
    C444,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub width: u32,
    pub height: u32,
    /// Frame rate as the file says it (60000/1001 for "59.94").
    pub fps_num: u32,
    pub fps_den: u32,
    pub chroma: Chroma,
}

impl Header {
    /// The frame rate as a whole number of frames per second, 59.94 counting as 60 (which is what the engine stamps by).
    pub fn fps(&self) -> u32 {
        ((u64::from(self.fps_num) + u64::from(self.fps_den) / 2) / u64::from(self.fps_den.max(1))).clamp(1, 240) as u32
    }

    /// Bytes of one picture's planes in the file.
    pub fn frame_bytes(&self) -> usize {
        let luma = self.width as usize * self.height as usize;
        match self.chroma {
            Chroma::C420 => luma + 2 * (self.width as usize).div_ceil(2) * (self.height as usize).div_ceil(2),
            Chroma::C444 => luma * 3,
        }
    }

    /// Bytes of one picture as NV12.
    pub fn nv12_bytes(&self) -> usize {
        self.width as usize * self.height as usize * 3 / 2
    }
}

const BAD: &str = "That isn't a Y4M video file.";

/// Reads the first line of a Y4M file (without its newline).
pub fn parse_header(line: &str) -> Result<Header> {
    let mut tags = line.split(' ');
    if tags.next() != Some("YUV4MPEG2") {
        return Err(Error::new(BAD));
    }
    let (mut width, mut height, mut rate, mut chroma) = (0u32, 0u32, (30u32, 1u32), Chroma::C420);
    for tag in tags {
        let Some(first) = tag.chars().next() else { continue };
        let rest = &tag[first.len_utf8()..];
        match first {
            'W' => width = rest.parse().map_err(|_| Error::new(BAD))?,
            'H' => height = rest.parse().map_err(|_| Error::new(BAD))?,
            'F' => {
                let (n, d) = rest.split_once(':').ok_or_else(|| Error::new(BAD))?;
                rate = (n.parse().map_err(|_| Error::new(BAD))?, d.parse().map_err(|_| Error::new(BAD))?);
                if rate.0 == 0 || rate.1 == 0 {
                    return Err(Error::new("That Y4M video has no frame rate."));
                }
            }
            'C' => {
                chroma = match rest {
                    "420" | "420jpeg" | "420mpeg2" | "420paldv" => Chroma::C420,
                    "444" => Chroma::C444,
                    _ => return Err(Error::new("Only 8-bit 4:2:0 and 4:4:4 Y4M videos can be read.")),
                }
            }
            // "p" is progressive; "?" is "don't know". The engine only does whole pictures.
            'I' if !matches!(rest, "p" | "?") => return Err(Error::new("Interlaced Y4M videos can't be read.")),
            // A (pixel shape), X (comments) and anything newer are of no use here.
            _ => {}
        }
    }
    if width == 0 || height == 0 {
        return Err(Error::new(BAD));
    }
    if width % 2 != 0 || height % 2 != 0 {
        return Err(Error::new("The Y4M video's width and height have to be even."));
    }
    if width > 8192 || height > 8192 {
        return Err(Error::new("That Y4M video is bigger than Uncbox streams."));
    }
    Ok(Header { width, height, fps_num: rate.0, fps_den: rate.1, chroma })
}

/// A Y4M file being read one picture at a time.
pub struct Y4mReader<R: BufRead> {
    input: R,
    pub header: Header,
    raw: Vec<u8>,
}

impl<R: BufRead> Y4mReader<R> {
    pub fn new(mut input: R) -> Result<Self> {
        let mut line = String::new();
        // A real header is a few dozen bytes; a file that isn't Y4M may have no newline for a long time.
        let read = input.by_ref().take(4096).read_line(&mut line)?;
        if read == 0 || !line.ends_with('\n') {
            return Err(Error::new(BAD));
        }
        let header = parse_header(line.trim_end_matches(['\n', '\r']))?;
        let raw = vec![0u8; header.frame_bytes()];
        Ok(Y4mReader { input, header, raw })
    }

    /// Reads the next picture into `nv12` (replacing what it held). `false` at the end of the file.
    pub fn read_nv12(&mut self, nv12: &mut Vec<u8>) -> Result<bool> {
        let mut line = String::new();
        let n = self.input.by_ref().take(4096).read_line(&mut line)?;
        if n == 0 {
            return Ok(false);
        }
        if !line.starts_with("FRAME") || !line.ends_with('\n') {
            return Err(Error::new("The Y4M video is damaged (a picture doesn't start where it should)."));
        }
        match self.input.read_exact(&mut self.raw) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Err(Error::new("The Y4M video ends in the middle of a picture.")),
            Err(e) => return Err(e.into()),
        }
        to_nv12(&self.header, &self.raw, nv12);
        Ok(true)
    }
}

/// Lays one picture's planes (`raw`, as the file has them) out as NV12 in `nv12`.
pub fn to_nv12(header: &Header, raw: &[u8], nv12: &mut Vec<u8>) {
    let (w, h) = (header.width as usize, header.height as usize);
    nv12.clear();
    nv12.reserve(header.nv12_bytes());
    nv12.extend_from_slice(&raw[..w * h]);
    match header.chroma {
        Chroma::C420 => {
            let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
            let (u, v) = (&raw[w * h..w * h + cw * ch], &raw[w * h + cw * ch..w * h + 2 * cw * ch]);
            for i in 0..cw * ch {
                nv12.push(u[i]);
                nv12.push(v[i]);
            }
        }
        Chroma::C444 => {
            let (u, v) = (&raw[w * h..2 * w * h], &raw[2 * w * h..3 * w * h]);
            // Each 2 x 2 block of colour values becomes one, rounded.
            for y in (0..h).step_by(2) {
                for x in (0..w).step_by(2) {
                    let at = y * w + x;
                    let avg = |plane: &[u8]| {
                        ((u32::from(plane[at]) + u32::from(plane[at + 1]) + u32::from(plane[at + w]) + u32::from(plane[at + w + 1]) + 2) / 4) as u8
                    };
                    nv12.push(avg(u));
                    nv12.push(avg(v));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn file(header: &str, frames: &[Vec<u8>]) -> Vec<u8> {
        let mut out = format!("{header}\n").into_bytes();
        for f in frames {
            out.extend_from_slice(b"FRAME\n");
            out.extend_from_slice(f);
        }
        out
    }

    #[test]
    fn reads_the_usual_header() {
        let h = parse_header("YUV4MPEG2 W1920 H1080 F60:1 Ip A1:1 C420jpeg XYSCSS=420JPEG").unwrap();
        assert_eq!((h.width, h.height, h.fps_num, h.fps_den, h.chroma), (1920, 1080, 60, 1, Chroma::C420));
        assert_eq!(h.fps(), 60);
    }

    #[test]
    fn the_order_of_tags_does_not_matter_and_colour_defaults_to_420() {
        let h = parse_header("YUV4MPEG2 F30000:1001 H720 W1280").unwrap();
        assert_eq!((h.width, h.height, h.chroma), (1280, 720, Chroma::C420));
        assert_eq!(h.fps(), 30);
        assert_eq!(parse_header("YUV4MPEG2 W16 H16 F60000:1001 C420mpeg2").unwrap().fps(), 60);
        assert_eq!(parse_header("YUV4MPEG2 W16 H16 F25:1 C420paldv").unwrap().fps(), 25);
        // No frame rate: 30.
        assert_eq!(parse_header("YUV4MPEG2 W16 H16").unwrap().fps(), 30);
    }

    #[test]
    fn reads_444() {
        let h = parse_header("YUV4MPEG2 W4 H2 F30:1 C444").unwrap();
        assert_eq!(h.chroma, Chroma::C444);
        assert_eq!(h.frame_bytes(), 4 * 2 * 3);
        assert_eq!(h.nv12_bytes(), 12);
    }

    #[test]
    fn turns_down_what_it_cannot_do() {
        for bad in [
            "",
            "RIFF W16 H16",
            "YUV4MPEG2",
            "YUV4MPEG2 W16",
            "YUV4MPEG2 H16",
            "YUV4MPEG2 W0 H16",
            "YUV4MPEG2 Wx H16",
            "YUV4MPEG2 W16 H16 F30",
            "YUV4MPEG2 W16 H16 F0:1",
            "YUV4MPEG2 W16 H16 F30:0",
            "YUV4MPEG2 W16 H16 C422",
            "YUV4MPEG2 W16 H16 C420p10",
            "YUV4MPEG2 W16 H16 Cmono",
            "YUV4MPEG2 W16 H16 It",
            "YUV4MPEG2 W15 H16",
            "YUV4MPEG2 W16 H15",
            "YUV4MPEG2 W9000 H16",
        ] {
            assert!(parse_header(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_420_picture_becomes_nv12() {
        // 4 x 2: eight brightness values, then U (2 x 1) and V (2 x 1).
        let frame = vec![1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21];
        let mut reader = Y4mReader::new(Cursor::new(file("YUV4MPEG2 W4 H2 F30:1 C420", &[frame]))).unwrap();
        let mut nv12 = Vec::new();
        assert!(reader.read_nv12(&mut nv12).unwrap());
        assert_eq!(nv12, vec![1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 11, 21]);
        assert!(!reader.read_nv12(&mut nv12).unwrap(), "then the end");
    }

    #[test]
    fn a_444_picture_gets_its_colour_averaged_into_nv12() {
        let mut frame: Vec<u8> = (1..=8).collect(); // 4 x 2 brightness
        frame.extend_from_slice(&[10, 20, 30, 40, 50, 60, 70, 81]); // U
        frame.extend_from_slice(&[0, 0, 100, 100, 0, 0, 100, 101]); // V
        let mut reader = Y4mReader::new(Cursor::new(file("YUV4MPEG2 W4 H2 F30:1 C444", &[frame]))).unwrap();
        let mut nv12 = Vec::new();
        assert!(reader.read_nv12(&mut nv12).unwrap());
        // U blocks: (10+20+50+60)/4 = 35, (30+40+70+81)/4 = 55.25 -> 55. V: 0 and (100+100+100+101)/4 = 100.25 -> 100.
        assert_eq!(&nv12[8..], &[35, 0, 55, 100]);
        assert_eq!(&nv12[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn several_pictures_and_frame_parameters() {
        let a = vec![9u8; 6];
        let b = vec![7u8; 6];
        let mut bytes = b"YUV4MPEG2 W2 H2 F30:1\n".to_vec();
        bytes.extend_from_slice(b"FRAME\n");
        bytes.extend_from_slice(&a);
        bytes.extend_from_slice(b"FRAME Ixyz\n");
        bytes.extend_from_slice(&b);
        let mut reader = Y4mReader::new(Cursor::new(bytes)).unwrap();
        let mut nv12 = Vec::new();
        assert!(reader.read_nv12(&mut nv12).unwrap());
        assert_eq!(nv12, vec![9; 6]);
        assert!(reader.read_nv12(&mut nv12).unwrap());
        assert_eq!(nv12, vec![7; 6]);
        assert!(!reader.read_nv12(&mut nv12).unwrap());
    }

    #[test]
    fn a_file_with_no_pictures_is_just_empty() {
        let mut reader = Y4mReader::new(Cursor::new(b"YUV4MPEG2 W2 H2 F30:1\n".to_vec())).unwrap();
        assert!(!reader.read_nv12(&mut Vec::new()).unwrap());
    }

    #[test]
    fn damaged_files_end_with_a_plain_sentence() {
        let cut = {
            let mut bytes = file("YUV4MPEG2 W2 H2 F30:1", &[vec![1; 6]]);
            bytes.truncate(bytes.len() - 2);
            bytes
        };
        let mut reader = Y4mReader::new(Cursor::new(cut)).unwrap();
        let err = reader.read_nv12(&mut Vec::new()).unwrap_err();
        assert!(err.message().contains("middle of a picture"), "{err}");

        let mut reader = Y4mReader::new(Cursor::new(b"YUV4MPEG2 W2 H2 F30:1\nFRAM\n123456".to_vec())).unwrap();
        assert!(reader.read_nv12(&mut Vec::new()).is_err());
        let mut reader = Y4mReader::new(Cursor::new(b"YUV4MPEG2 W2 H2 F30:1\nNOTAFRAME".to_vec())).unwrap();
        assert!(reader.read_nv12(&mut Vec::new()).is_err());
    }

    #[test]
    fn files_that_are_not_y4m_are_refused_quickly() {
        assert!(Y4mReader::new(Cursor::new(Vec::new())).is_err());
        assert!(Y4mReader::new(Cursor::new(b"YUV4MPEG2 W2 H2".to_vec())).is_err(), "no newline");
        assert!(Y4mReader::new(Cursor::new(vec![0x47u8; 100_000])).is_err());
        assert!(Y4mReader::new(Cursor::new(b"\x00\x00\x00\x18ftypmp42\n".to_vec())).is_err());
    }
}
