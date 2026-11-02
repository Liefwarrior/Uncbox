# uncbox-stream: Uncbox's own streaming engine

One small Windows program that does everything the FFmpeg process in `server/stream.mjs` does to put
a screen on Twitch, in Rust, with the same picture:

```
screen ──▶ Desktop Duplication ──▶ cursor ──▶ video processor ──▶ NVENC (NVIDIA, direct) ───┐
 (card)        (capture)          (shader)   (BGRA→NV12, turn,   or Media Foundation          │
                                              scale)             (AMD, Intel)                ├─▶ FLV ─▶ RTMP(S) ─▶ Twitch
Uncbox app ──▶ named pipe ──▶ same clock ──▶ AAC (Media Foundation) ───────────────────────┘
```

Every step of the picture happens on the graphics card. The processor only ever touches the small
compressed stream. That is the point: FFmpeg 8.1's `scale_d3d11` can't take the screen capture's
frames, so the FFmpeg setup copies every frame to the processor (or out and back in for CUDA) to
scale it. This reaches 60 fps at 3 to 10 percent of one core where FFmpeg uses 15 to 80 percent.

On NVIDIA cards the encoder is driven directly (`nvEncodeAPI64.dll`), with the settings FFmpeg's
`h264_nvenc` is given (B-frames, look-ahead, a first pass at quarter size, adaptive quantisation
over time), because Windows' own interface to NVIDIA's encoder takes none of those. On the same
clip at 6000 kbit/s the engine's picture scores the same VMAF as FFmpeg's (see [Measured](#measured)).

Uncbox uses it only when launched the lighter way (see [Using it from Uncbox](#using-it-from-uncbox)),
and falls back to FFmpeg when it isn't built or can't stream here.

## Building

The Windows toolchain here is Rust's `x86_64-pc-windows-gnullvm` target, linked with LLVM-MinGW. It
needs no Visual Studio and no admin rights (the MSVC toolchain wants the C++ build tools, which are
a multi-gigabyte install). Both install per user:

```powershell
winget install Rustlang.Rustup
winget install MartinStorsjo.LLVM-MinGW.UCRT
rustup default stable-x86_64-pc-windows-gnullvm
```

Cargo and the LLVM-MinGW compiler have to be on `PATH`. In a Git Bash session (the version number
in the LLVM-MinGW folder changes):

```bash
export PATH="$HOME/.cargo/bin:$LOCALAPPDATA/Microsoft/WinGet/Packages/MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/llvm-mingw-20261020-ucrt-x86_64/bin:$PATH"
```

Then, from the Uncbox folder:

```bash
npm run engine          # cd engine && cargo build --release  ->  engine/target/release/uncbox-stream.exe
cd engine && cargo test # the unit tests
cd engine && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

It has to be built from inside `engine/` (that is what `npm run engine` does): `engine/.cargo/config.toml`
links the C runtime and the unwinder into the program, so the exe runs on a PC without LLVM-MinGW.
It then needs only DLLs that ship with Windows (and `nvEncodeAPI64.dll`, which the NVIDIA driver
ships, loaded only when it is wanted). Its two dependencies are `serde_json` and `native-tls`
(Windows' own TLS, SChannel, so there is no certificate list of our own to keep up to date),
besides the `windows` crate for the Windows APIs.

## The program

```
uncbox-stream probe     one line of JSON on stdout, exit 0
uncbox-stream run       one line of JSON settings on stdin, then it streams
```

### probe

About 0.3 s. Which cards there are, which screens are on them, and which encoders really encode
(a few dozen tiny pictures are put through each, so a driver that is installed but refuses is
found out):

```json
{ "version": "0.1.0",
  "adapters": [ { "name": "NVIDIA GeForce RTX 5090 Laptop GPU", "vendor": "nvidia",
                  "outputs": [ { "index": 0, "width": 2560, "height": 1440, "primary": true } ],
                  "encoder": { "backend": "nvenc", "tuning": "quality", "bframes": 2 } } ],
  "encoders": [ { "id": "nvidia", "maker": "nvidia", "tuning": "quality", "backend": "nvenc", "bframes": 2 } ],
  "backend": { "nvidia": "nvenc" },
  "tuning": { "nvidia": "quality" },
  "primary": 0 }
```

- `encoders` has one object per maker whose encoder works (`id` and `maker` are the same word:
  `nvidia`, `amd` or `intel`). **This changed from a list of plain strings** (the first version of
  the engine printed `["nvidia"]`); `backend` and `tuning` per maker are also kept as the separate
  maps shown, for anything that wants them.
- `tuning` is `quality` when the card took the full FFmpeg-equivalent settings and `safe` when it
  refused part of them (an older card without B-frames as references, for one). `backend` is `nvenc`
  (the direct NVIDIA encoder) or `mediafoundation` (AMD, Intel, and NVIDIA when NVENC can't open).
- `primary` is the screen number Windows calls the main one (each output also says `primary`).
- Screens are numbered across all cards in the order Windows lists them, the same way FFmpeg's
  `ddagrab` counts.

### run

Reads one JSON line from stdin. `src/settings.rs` is the one place all settings live, with their
defaults and limits; unknown fields are ignored so the settings can grow. The server's usual line,
`{ url, screen, fps, height, kbps, audioPipe?, encoder: "auto" }`, is all that is needed.

| field | meaning | default / limits |
| --- | --- | --- |
| `url` | `rtmp://` or `rtmps://` address with the stream key in it (the only required field), or `file:<path>.flv` (testing, below) | |
| `screen` | which monitor, 0 is the first Windows lists | 0, clamped 0 to 7 |
| `fps` | 30 or 60 | 60 |
| `height` | 720, 1080, or 0 for the screen's own size | 1080 |
| `kbps` | video bitrate | 6000, clamped 2500 to 8000 |
| `audioPipe` | the Uncbox app's sound pipe, `\\.\pipe\uncbox-stream-audio-<8 to 32 hex>`; silence without it | none |
| `encoder` | `auto`, `nvidia`, `amd` or `intel` (must be the maker of the card the screen is on) | `auto` |
| `keyframeSeconds` | seconds between keyframes | 2, clamped 1 to 4 |
| `audioKbps` | AAC bitrate (96, 128, 160 or 192) | 160 |
| `bframes` | B-frames, if the encoder takes them | 2, clamped 0 to 3 |
| `quality` | Media Foundation only, safe settings only: 0 fastest, 100 best looking (the quality settings ask for 100) | 80 |
| `tuning` | `auto`, `quality` or `safe`: where NVENC starts (`safe` skips the quality attempt, for a probe that already found it refused) | `auto` |
| `backend` | `auto`, `nvenc` or `mf`: `mf` makes an NVIDIA card use Media Foundation (for comparing); `nvenc` refuses to fall back | `auto` |
| `source` | `{ "y4m": "<file>" }`: encode a video file instead of the screen (testing) | the screen |
| `pace` | with a file as the source: `true` sends at the file's frame rate, `false` as fast as the encoder takes it (no sound then) | `true` |

Then, every second, a block on stdout in FFmpeg's `-progress` format (`frame=`, `fps=`, `bitrate=`,
`total_size=`, `out_time_us=`, `dup_frames=`, `drop_frames=`, `speed=`, `progress=continue`), so the
server's `createProgressParser()` reads it unchanged. Each block also carries a few extra lines the
parser skips and a reader can use: `encoder_backend=nvenc|mediafoundation`, `encoder_name=...`,
`encoder_bframes=N`, `encoder_tuning=quality|safe` (NVENC only) and `source=screen|y4m`. A line `q` on
stdin (or closing stdin, for a stream of the screen) stops capturing, flushes both encoders, sends
the last packets, closes RTMP properly and exits 0 (about 100 to 250 ms with NVENC, which flushes its
look-ahead). `progress=end` is the last block. Any fatal problem is one plain sentence on stderr and
a non-zero exit. Before the first picture, one informational line on stderr says what runs ("Streaming
with NVIDIA GeForce RTX 5090 Laptop GPU NVENC (quality settings, 2 B-frames)."); an encoder that turned
down settings gets a line too. Neither is the last line of a failed stream.

**The stream key** arrives on stdin, not in the arguments (which any program on the PC can read). Every
line the engine prints goes through `redact`: anything shaped `live_<digits>_<letters>`, the whole
address, and the key itself in any other service's shape (registered when the address is read, also
percent-encoded) is blanked. Panics print a fixed sentence.

## What the picture is made with

| FFmpeg (`encoderArgs('nvenc', kbps, fps, 'quality')`) | the engine, `tuning: quality` |
| --- | --- |
| `-preset p6 -tune hq` | preset P6, high-quality tuning |
| `-rc cbr -b:v K -maxrate K -bufsize 2K` | constant bitrate K, maximum K, VBV buffer 2K |
| `-multipass qres` | first pass at quarter resolution |
| `-temporal-aq 1` (spatial AQ left off) | temporal AQ on, spatial AQ off |
| `-rc-lookahead 20` | look-ahead 20 |
| `-bf 2 -b_ref_mode middle` | 2 B-frames, the middle one a reference |
| `-g fps*2 -profile:v high` | an IDR keyframe every GOP (2 s), High profile, CABAC |

`tuning: safe` is FFmpeg's `safe` set: P5 and high-quality tuning, constant bitrate, 2 B-frames (none if
the card has none). The engine tries quality, then safe, then safe without B-frames, each first on a
tiny test clip and then for real, and reports the one that worked. Struct layouts are hand-written
(`src/nvapi.rs`) from FFmpeg's `nv-codec-headers` (MIT) for NVENC API 13.1, with size and offset
asserts checked at build time against the header; a driver that speaks 13.0 is told 13.0 (the same
layouts), and an older one is not used (Media Foundation is).

Pictures leave NVENC in decode order, so the engine works out decode times the way FFmpeg does
(`src/reorder.rs`) and puts the difference into the FLV composition offsets; the sound is delayed by
the same amount and held until the picture catches up, so both stay in time stamp order on the wire.

**AMD and Intel (Media Foundation)** get the equivalents that interface has: constant bitrate, a
two-second buffer, CABAC, quality-over-speed at 100, no real-time mode, two passes and B-frames where
the encoder accepts them. Every setting's result is checked and what an encoder refuses is listed in
one line on stderr. Look-ahead, pre-analysis and adaptive quantisation (FFmpeg's `-preanalysis`,
`-vbaq`) have no Media Foundation setting, so they cannot be asked for.

**HDR screens** are asked for as an ordinary 8-bit picture (`DuplicateOutput1` with BGRA), so Windows
hands over the SDR version, as FFmpeg's `ddagrab` does when told to. **Rotated screens** are sent
upright: the video processor turns the picture, and the mouse cursor is placed and turned onto the
picture Windows gives. **A new resolution, a turn or HDR switched on or off mid-stream** restarts
the capture and keeps the stream going at the same size, fitting the new picture into it (black
bars if the shape differs).

## How it works

| file | what it does |
| --- | --- |
| `settings.rs` | the settings above, clamped; `target_size`; `file:` addresses |
| `gpu.rs` | finds the graphics cards and their screens, opens Direct3D 11 on the right one |
| `capture.rs` | Desktop Duplication into a texture (SDR even on HDR screens, restarted when the screen changes); the cursor drawn on a copy with a small shader (colour cursors blend; black-and-white inverting ones use the two-step mask trick Windows does) |
| `source.rs`, `y4m.rs` | the picture sources: the screen, or a Y4M file uploaded to the card one picture at a time |
| `orient.rs` | which way up a screen is, and how a picture of one size fits another |
| `convert.rs` | the Direct3D 11 video processor: BGRA (or NV12) to NV12 BT.709, turning and scaling in one pass; a plain copy when the file already is what the encoder takes; the pool of pictures |
| `encoder.rs` | chooses NVENC or Media Foundation and gives the pipeline one way to talk to either |
| `nvenc.rs`, `nvapi.rs`, `tuning.rs`, `reorder.rs` | NVIDIA's encoder directly: the session, the registered textures, the settings, decode times for B-frames |
| `mf.rs` | Media Foundation: the card's H.264 encoder fed Direct3D textures, and Windows' AAC encoder |
| `audio.rs` | the app's named pipe (f32le, 48 kHz, stereo), or silence; keeps it on the clock |
| `h264.rs`, `flv.rs` | Annex B to length-prefixed NAL units, the AVC and AAC sequence headers, `onMetaData`, FLV tags |
| `amf0.rs`, `rtmp.rs`, `net.rs` | AMF0, the handshake, chunking, connect / publish, acknowledgements and pings; TCP and TLS (SChannel) |
| `sink.rs` | where the stream goes: RTMP, or an FLV file |
| `queue.rs` | the line to the network thread; thins out video when the connection is slow; holds sound for the picture |
| `pipeline.rs`, `probe.rs` | the threads and the clock; what `run` does; the shape of the probe |
| `progress.rs`, `redact.rs`, `log.rs` | the report, the key filter, the messages |

**Threads.** Capture (wakes on the frame clock and never waits on anything slow), encoder, sound,
network (the only one that writes to the server), and main (listens for `q`, prints the report).

**One clock.** Picture *n* is stamped *n*/fps seconds after the start; sound is stamped by the number
of samples that have gone out; both are measured from the moment the app's pipe was opened (its writer
starts its own real-time clock then). If the screen hasn't changed the last picture is sent again
(counted in `dup_frames`). If the machine is late, whole slots are skipped and counted as dropped,
never stretched. If the pipe goes quiet, silence is filled in; if a late burst follows, the blocks
that would put the sound ahead are dropped; if the pipe closes, the app is gone and the engine exits
with an error (the page starts the stream again).

**The pictures.** Each converted picture comes from a pool and stays out of it until the encoder is
done with it, which with look-ahead is about 27 pictures (34 in the pool). If the pool is empty the
slot is skipped and counted.

**When the connection is slow.** The network thread writes with a bounded line in front of it. Past
0.4 s of video waiting, pictures nothing else is built from are dropped; past 1.5 s, everything older
than the newest keyframe goes and the encoder is asked for a fresh keyframe (an IDR, with the
parameter sets). Sound is never dropped. Every dropped picture is counted in `drop_frames`. Checked
with B-frames through a throttled connection: the file decodes with no errors, decode times only go up.

## Using it from Uncbox

FFmpeg streams by default. The engine streams only when asked for: `npm run app:native` (or
`--engine=native` on the app), the **Uncbox (lighter streaming)** Start-menu entry of an installed
copy, `UNCBOX_STREAM_ENGINE=native` for `npm start`, or `POST /api/stream/engine { "engine": "native" }`
from this PC (409 while a stream runs).

`server/stream.mjs` looks for `uncbox-stream.exe` next to the server (a packaged copy, put there by
`npm run package`), one folder up, then in `engine/target/release` (a checkout). It streams with the
engine when `probe` answers with a known encoder; otherwise it streams with FFmpeg and prints one
line in the server's console. The page sees the same status either way: `tools.encoder` is
nvenc/amf/qsv (the page's names for nvidia/amd/intel), `tools.tuning` comes from the probe, and
`tools.ffmpeg` and `tools.ddagrab` are true with `scaler` `d3d11`, so the page never asks for FFmpeg.
`tools.engine` (`native`/`ffmpeg`) is there for diagnosis only. Only reasons a stream stopped go to
stderr (the page shows the last line when a stream drops); notes on how it is made go to the debug
log (`UNCBOX_STREAM_DEBUG=1`).

`scripts/engine.mjs` finds cargo (adding `~/.cargo/bin` and LLVM-MinGW's `bin` to PATH), rebuilds a
stale exe for `npm run app:native`, and `npm run package` builds the engine too. For tests only,
`UNCBOX_STREAM_INGEST=rtmp://127.0.0.1:PORT/app` sends the stream to a local receiver instead of
Twitch.

## Testing and tooling

Two features exist only so the engine can be tested and its picture compared with FFmpeg's. Nothing
in Uncbox uses them.

- **`"source": { "y4m": "<path>" }`** reads a Y4M file (8-bit 4:2:0 or 4:4:4) instead of the screen:
  each picture is uploaded to the card and goes through the same convert, scale, encode path. The
  file's frame rate rules (59.94 counts as 60). Paced by default; `"pace": false` goes as fast as the
  encoder takes it and makes no sound. Every picture is sent (none skipped). Closing stdin doesn't stop
  it (only `q` does), so `echo {...} | uncbox-stream run` works.
- **`"url": "file:<path>.flv"`** writes the FLV that would have gone to the server to a file (forms
  `file:C:\x\a.flv`, `file:C:/x/a.flv`, `file:out/a.flv` and the URL spellings `file:///C:/x/a.flv`
  work; only `.flv` names are written). Nothing is thinned out.

```bash
node engine/scripts/e2e.mjs --suite                    # live screen, three settings, ffprobe checks
node engine/scripts/e2e.mjs --suite --both --runs 2    # the engine and FFmpeg, twice each
node engine/scripts/e2e.mjs --engine native --seconds 30 --height 1080 --fps 60 --kbps 6000 --motion
node engine/scripts/quality.mjs "D:/Clips/Replay.mp4" --start 20 --dur 20 --tag smite
```

`e2e.mjs` streams the screen to a local FFmpeg RTMP listener (nothing leaves the PC) and reads the
file that arrives with ffprobe: H.264 High, B-frames (on NVENC), keyframes never more than 2 s apart,
decode times that only go up, AAC 48 kHz stereo, and about as many pictures as the time asked for.
`quality.mjs` is the VMAF comparison described below. `UNCBOX_STREAM_DEBUG=1` prints what the engine
is doing (key filtered, as everything is), and `UNCBOX_STREAM_TLS_ROOT=<certificate file>` adds one
certificate to those Windows trusts, so a local TLS test server can be used.

## Measured

RTX 5090 Laptop GPU (driver 617.42, NVENC 13.1), Windows 11, two 2560×1440 screens on that one card
(one of them HDR), FFmpeg 8.1.2.

### Picture quality

Two SMITE clips (`Replay 2026-09-13 13-36-50.mp4` from 20 s and `14-16-52.mp4` from 25 s, 20 s each,
1080p60) encoded at 6000 kbit/s CBR from the same Y4M and scored against the source with VMAF
(libvmaf default model; the 5% and 1% lows are of the per-frame scores) and PSNR of the brightness. "FFmpeg" is
`encoderArgs('nvenc', 6000, 60, 'quality')` from `server/stream.mjs`; "engine MF" is the engine forced
onto Windows' Media Foundation encoder (`"backend": "mf"`), which is what an NVIDIA card gets if NVENC can't open.

| clip | encoder | VMAF mean | 5% low | 1% low | PSNR Y | kbit/s |
| --- | --- | --- | --- | --- | --- | --- |
| smite | **engine, NVENC** | 93.27 | 82.62 | 74.72 | 40.67 | 6101 |
| | FFmpeg, NVENC | 93.27 | 82.62 | 74.72 | 40.67 | 6092 |
| | engine, Media Foundation | 88.85 | 64.02 | 56.86 | 37.55 | 5765 |
| smite2 | **engine, NVENC** | 92.64 | 82.32 | 75.98 | 40.46 | 6069 |
| | FFmpeg, NVENC | 92.64 | 82.48 | 75.65 | 40.45 | 6060 |
| | engine, Media Foundation | 88.86 | 66.38 | 55.48 | 38.01 | 5782 |

The two NVENC bitstreams are, as far as can be seen, the same: on `smite` the bytes of each kind of
H.264 unit match FFmpeg's to within filler data. (The kbit/s differ only by the container.) Media
Foundation's encoder, with no B-frames or look-ahead, is about 4.4 VMAF points worse and much worse
on its hardest frames. The Intel iGPU in this PC has no screen on it and no encoder Windows will
give it, so the AMD/Intel settings of the Media Foundation path could not be exercised on their
own hardware.

### The live screen

30 s of screen 0 streamed to a local FFmpeg listener, silent audio, then `q`; the file that arrived was read
with ffprobe. "CPU" is the program's own processor time over the 25 s after a 5 s warm-up, as a percent
of one core; "encoder" and "GPU" are `nvidia-smi dmon` averages (the whole card, other work included).
Each cell is two runs. All delivered the right size, H.264 High, AAC LC 48 kHz stereo, DTS that only
go up, and 60 (or 30) fps.
FFmpeg is the command `server/stream.mjs` builds (ddagrab, CUDA scaling, NVENC quality settings).

| 30 s, screen 0 | program | CPU % of one core | encoder % | dropped | B-frames in 30 s |
| --- | --- | --- | --- | --- | --- |
| 1080p60 · 6000, idle screen | **engine** | **3.5 / 6.9** | 4.0 / 3.6 | 0 / 0 | 893 / 893 |
| | FFmpeg | 34.7 / 43.3 | 4.3 / 3.2 | 3 / 2 | 910 / 1201 |
| 1080p60 · 6000, moving picture | **engine** | **9.5 / 10.1** | 3.9 / 3.4 | 0 / 0 | 895 / 893 |
| | FFmpeg | 83.2 / 79.8 | 3.6 / 4.2 | 6 / 4 | 900 / 901 |
| screen size 2560×1440 60 · 6000, idle | **engine** | **8.7 / 10.3** | 10.7 / 9.4 | 0 / 0 | 1033 / 899 |
| | FFmpeg | 37.6 / 41.0 | 8.9 / 6.5 | 1 / 0 | 975 / 934 |
| screen size 2560×1440 60 · 6000, moving | **engine** | **7.6 / 5.3** | 8.5 / 8.5 | 0 / 0 | 894 / 894 |
| | FFmpeg | 11.5 / 15.7 | 7.2 / 8.6 | 1 / 1 | 898 / 897 |
| 720p30 · 3000, idle | **engine** | **4.9 / 8.7** | 1.3 / 1.0 | 1 / 0 | 511 / 497 |
| | FFmpeg | 36.4 / 34.3 | 0.6 / 1.6 | 1 / 0 | 572 / 585 |
| 720p30 · 3000, moving | **engine** | **5.0 / 4.0** | 1.3 / 0.8 | 2 / 1 | 588 / 590 |
| | FFmpeg | 16.3 / 22.9 | 1.3 / 0.9 | 1 / 2 | 597 / 595 |

The numbers move a lot from run to run (other work was running on this PC, and a process's CPU time
at this level is partly timer and driver noise), but the picture is steady: the engine uses a few
percent of a core where FFmpeg uses 15 to 80, drops no more than FFmpeg, and stops in 100 to 250 ms
against 215 to 500. The engine's bitrate is a little above FFmpeg's in the container (6.1 against 6.09 Mbit/s,
the FLV muxing and the sound). Keyframes are exactly 2 s apart on a steady picture; NVENC's look-ahead
also starts one at a scene change, so on a changing desktop a gap can be shorter (never longer), for the
engine and for FFmpeg alike.

Also checked:

- 165 s of 1080p60 held steady at 271 to 276 MB (the NVENC look-ahead keeps about 34 pictures on the card, so
  this is more than the 80 MB of the Media Foundation version) and 637 to 645 handles.
- An HDR screen (Windows' advanced colour on, the engine's second screen) streams: the picture arrives as the
  SDR version, with ordinary colours. The old engine ended with a message on it.
- A screen set to 1920×1080, then 1280×1024, then back to 2560×1440 during a stream: the stream carries on at
  1920×1080, with legal black bars (limited-range 16) around the 5:4 picture, and exits 0.
- A screen turned 90° and 270° during a stream, covered with a known picture: the stream shows it upright (the clock
  reads left to right at the top left in both), and the mouse arrow lands where it should (within a pixel of
  the spot expected for the upright screen, in both turns).
- A slow connection (a proxy limited to 2.4 Mbit/s): 1112 of 1440 pictures dropped, forced keyframes made, and the
  file decodes with no errors and rising decode times.
- A Y4M file played paced (5 s in 5.4 s, with sound) and as fast as possible (5 s of 1080p60 in about 1 s).
- `q` ends it in 100 to 250 ms; a dead server, a closed sound pipe, an unreachable address and a bad screen
  number each end it with one plain sentence and exit code 1; `rtmps://` works through Windows' TLS against
  a local TLS endpoint (a self-signed certificate trusted through the test-only variable above) and
  refuses one it doesn't trust (these last ones were checked with the first version of the engine).

## What isn't done, or isn't known

- **AMD and Intel are untested.** The code path is Media Foundation's, found per graphics card (and
  matched to the maker by the encoder's name, because Windows offers an NVIDIA encoder when asked for an
  Intel card's), but there is no AMD card on the test PC and the Intel chip here has no screen and no
  encoder. The same path was exercised through NVIDIA's Media Foundation encoder. Their quality will not equal
  FFmpeg's `h264_amf`/`h264_qsv` settings in two respects (no look-ahead or adaptive quantisation setting
  exists in Media Foundation) and whether their encoders take B-frames is up to them.
- **NVENC needs a driver that speaks NVENC API 13.0 or later** (about driver 570 and up); an older one falls
  back to Media Foundation (a plainer picture, the probe says `backend: mediafoundation`). The 12.x layouts differ
  and are not written.
- **NVENC's quality set on an older card** (no B-frames as references, say) falls back to the safe set; this
  fallback was exercised only by unit tests of the decision, because this card takes the quality set.
- **Cursor on a screen turned 180°** is placed by the same rule as 90° and 270° (checked there, and by unit
  tests for 180°) but not checked against a real display. A card whose video processor can't turn a picture
  would send the screen sideways with a warning (not seen on this card).
- The encoder runs on the card that owns the screen. A laptop whose screen hangs off the Intel chip
  while the NVIDIA card renders isn't supported (it says so, and FFmpeg has the same limit).
- The encoder's constant bitrate isn't strictly constant: on Media Foundation it runs 7 to 13 percent over
  (the engine aims at 93 percent of the rate there); NVENC held 6.07 to 6.2 Mbit/s of container at 6000.
- Not built, on purpose: other services, recording a second output, overlays composited on the card.
  `settings.rs`, `sink.rs` and `pipeline.rs` are laid out so each slots in.
