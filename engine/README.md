# uncbox-stream: Uncbox's own streaming engine

One small Windows program that does everything the FFmpeg process in `server/stream.mjs` used to do
to put a screen on Twitch, in Rust:

```
screen ──▶ Desktop Duplication ──▶ cursor ──▶ video processor ──▶ hardware H.264 ──┐
 (card)        (capture)          (shader)   (BGRA→NV12, scale)   (Media Foundation) │
                                                                                     ├─▶ FLV ─▶ RTMP(S) ─▶ Twitch
Uncbox app ──▶ named pipe ──▶ same clock ──▶ AAC (Media Foundation) ────────────────┘
```

Every step of the picture happens on the graphics card. The processor only ever touches the small
compressed stream. That is the whole point: FFmpeg 8.1's `scale_d3d11` can't take the screen
capture's frames, so the FFmpeg setup copied every frame to the processor to scale it, and reached
about 55 fps at 1080p. This reaches 60 and uses a small fraction of the processor (an FFmpeg that
does its scaling with CUDA instead gets to 60 too, but at a quarter to half of a core).

`server/stream.mjs` uses it automatically when it is built (see [Using it from Uncbox](#using-it-from-uncbox)),
and falls back to FFmpeg when it isn't.

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
It then needs only DLLs that ship with Windows. Its two dependencies are `serde_json` and `native-tls`
(which uses Windows' own TLS, SChannel, so there is no certificate list of our own to keep up to date),
besides the `windows` crate for the Windows APIs.

## The program

```
uncbox-stream probe     one line of JSON on stdout, exit 0
uncbox-stream run       one line of JSON settings on stdin, then it streams
```

**`probe`** answers in about 0.4 s: `{ "version", "adapters": [{ "name", "vendor", "outputs": [{ "index",
"width", "height", "primary" }] }], "encoders": ["nvidia"] }`. `encoders` lists the makers whose hardware
H.264 encoder was started for real (not just found), so the server can trust it. Screens are numbered
across all cards in the order Windows lists them, the same way FFmpeg's `ddagrab` counts.

**`run`** reads one JSON line from stdin. `src/settings.rs` is the one place all settings live, with
their defaults and limits; unknown fields are ignored so the settings can grow.

| field | meaning | default / limits |
| --- | --- | --- |
| `url` | `rtmp://` or `rtmps://` address with the stream key in it (the only required field) | |
| `screen` | which monitor, 0 is the first Windows lists | 0, clamped 0 to 7 |
| `fps` | 30 or 60 | 60 |
| `height` | 720, 1080, or 0 for the screen's own size | 1080 |
| `kbps` | video bitrate | 6000, clamped 2500 to 8000 |
| `audioPipe` | the Uncbox app's sound pipe, `\\.\pipe\uncbox-stream-audio-<8 to 32 hex>`; silence without it | none |
| `encoder` | `auto`, `nvidia`, `amd` or `intel` | `auto` |
| `keyframeSeconds` | seconds between keyframes | 2, clamped 1 to 4 |
| `audioKbps` | AAC bitrate (96, 128, 160 or 192) | 160 |
| `bframes` | B-frames, if the encoder takes them | 2, clamped 0 to 3 |
| `quality` | 0 fastest, 100 best looking | 80 |

Then, every second, a block on stdout in FFmpeg's `-progress` format (`frame=`, `fps=`, `bitrate=`,
`total_size=`, `out_time_us=`, `dup_frames=`, `drop_frames=`, `speed=`, `progress=continue`), so the
server's `createProgressParser()` reads it unchanged. A line `q` on stdin (or closing stdin) stops
capturing, flushes both encoders, sends the last packets, closes RTMP properly and exits 0 (measured:
under 60 ms). `progress=end` is the last block. Any fatal problem is one plain sentence on stderr and a
non-zero exit.

**The stream key** arrives on stdin, not in the arguments (which any program on the PC can read). Every
line the engine prints goes through `redact`: anything shaped `live_<digits>_<letters>`, the whole
address, and the key itself in any other service's shape (registered when the address is read, also
percent-encoded) is blanked. Panics print a fixed sentence.

## How it works

| file | what it does |
| --- | --- |
| `settings.rs` | the settings above, clamped; `target_size` keeps the shape and even sides |
| `gpu.rs` | finds the graphics cards and their screens, opens Direct3D 11 on the right one |
| `capture.rs` | Desktop Duplication into a texture; the mouse cursor drawn on a copy with a small shader (colour cursors blend; the black-and-white inverting ones, like the text I-beam, use the same two-step mask trick Windows does) |
| `convert.rs` | the Direct3D 11 video processor: BGRA to NV12 BT.709 and scaling in one pass on the card |
| `mf.rs` | Media Foundation: the card's H.264 encoder (CBR, VBV two seconds, High profile, CABAC, a keyframe every 2 s) fed Direct3D textures through the same device, and Windows' AAC encoder |
| `audio.rs` | the app's named pipe (f32le, 48 kHz, stereo), or silence; keeps it on the clock |
| `h264.rs`, `flv.rs` | Annex B to length-prefixed NAL units, the AVC and AAC sequence headers, `onMetaData`, FLV tags |
| `amf0.rs`, `rtmp.rs` | AMF0, the handshake, chunking (chunk size 4096), connect / releaseStream / FCPublish / createStream / publish, acknowledgements and pings |
| `net.rs` | TCP, and TLS (SChannel) for `rtmps://` on 443 |
| `queue.rs` | the line to the network thread; thins out video when the connection is slow |
| `pipeline.rs` | the threads and the clock; what `run` does |
| `progress.rs`, `redact.rs`, `log.rs` | the report, the key filter, the messages |

**Threads.** Capture (wakes on the frame clock and never waits on anything slow), encoder, sound,
network (the only one that writes to the server), and main (listens for `q`, prints the report).

**One clock.** Picture *n* is stamped *n*/fps seconds after the start; sound is stamped by the number
of samples that have gone out; both are measured from the moment the app's pipe was opened (its writer
starts its own real-time clock then). If the screen hasn't changed the last picture is sent again
(counted in `dup_frames`). If the machine is late, whole slots are skipped and counted as dropped,
never stretched, so picture and sound can't drift apart. If the pipe goes quiet, silence is filled in;
if a late burst follows, the blocks that would put the sound ahead are dropped; if the pipe closes, the
app is gone and the engine exits with an error (the page starts the stream again).

**When the connection is slow.** The network thread writes with a bounded line in front of it. Past
0.4 s of video waiting, pictures nothing else is built from are dropped; past 1.5 s, everything older
than the newest keyframe goes and the encoder is asked for a fresh keyframe. Sound is never dropped.
Every dropped picture is counted in `drop_frames`.

## Using it from Uncbox

`server/stream.mjs` looks for `uncbox-stream.exe` next to the server (a packaged copy, put there by
`npm run package`) and in `engine/target/release` (a checkout). If it is there and `probe` lists an
encoder, the engine does the streaming; otherwise FFmpeg does, exactly as before.
`UNCBOX_STREAM_ENGINE=ffmpeg` or `=native` forces one (`native` without a built engine says so rather than
quietly using FFmpeg). The stream status says which one is running: `tools.engine` is `native` or
`ffmpeg`, `tools.encoder` is `nvidia`, `amd` or `intel`.

## Measured

RTX 5090 Laptop GPU (driver 617.42), Windows 11, two 2560×1440 screens on that one card, FFmpeg 8.1.2.
Screen 0 captured for 30 s into a local FFmpeg listener (nothing leaves the PC), silent audio, then `q`;
the file that arrived was read with ffprobe. "CPU" is
the engine's own processor time divided by the 30 s, as a percent of one core; "GPU" and "encoder" are
`nvidia-smi dmon` averages (the whole card, so they include whatever else was drawing).
`node engine/scripts/e2e.mjs --engine native|ffmpeg --seconds 30 --height 1080 --fps 60 --kbps 6000`
repeats any of it.

Each line is two runs (separated by a slash) of 30 s. All delivered 1920×1080 (or the size shown) High
profile H.264, AAC LC 48 kHz stereo, monotonic time stamps and a keyframe exactly every 2 s.

| 30 s, screen 0 | engine | fps delivered | frames dropped | CPU, % of one core | GPU % | encoder % | video kbps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1080p60 · 6000, idle screen | **uncbox-stream** | 60.0 / 60.0 | 0 / 0 | **1.9 / 6.7** | 6.7 / 8.1 | 4.8 / 12.4 | 2779 / 2628 |
| | FFmpeg (current args) | 60.0 / 60.0 | 0 / 11 | 30.7 / 49.6 | 10.6 / 11.5 | 2.5 / 6.9 | 5949 / 5945 |
| 1080p60 · 6000, moving picture | **uncbox-stream** | 60.0 / 60.0 | 0 / 0 | **4.0 / 5.1** | 4.0 / 2.5 | 5.8 / 7.4 | 5935 / 3037 (a) |
| | FFmpeg (current args) | 60.0 / 60.0 | 0 / 0 | 33.6 / 23.6 | 6.2 / 5.2 | 4.1 / 2.5 | 5946 / 5943 |
| screen size 2560×1440 60 · 6000, idle | **uncbox-stream** | 60.0 | 0 | **3.2** | 8.0 | 6.5 | 2478 |
| | FFmpeg (current args) | 60.0 | 3 | 39.5 | 12.1 | 8.2 | 5949 |
| 720p30 · 3000, idle | **uncbox-stream** | 30.0 | 0 | **2.2** | 11.1 | 3.9 | 1073 |
| | FFmpeg (current args) | 30.0 | 1 | 16.6 | 12.8 | 3.8 | 2984 |

(a) In the second moving-picture run the test window didn't come up, so it is really another idle run.

"FFmpeg (current args)" is the command line from the branch that moved FFmpeg to CUDA scaling (`hwdownload,
format=bgra, hwupload_cuda, scale_cuda` with lanczos, `h264_nvenc` p6 hq, `qres` multipass, temporal AQ,
lookahead 10, 2 B-frames, CBR), pointed at the local receiver. The FFmpeg that is on `main` today (scaling
on the processor) reached only 54 to 57 fps at 1080p60 in earlier runs on this PC.

What to take from it. Both now hold the frame rate; the difference is what it costs. The engine uses about
2 to 7 percent of one core where FFmpeg uses 17 to 50 percent, drops nothing (FFmpeg dropped up to 11 frames
in 30 s), and ends in 40 to 50 ms against 280 to 490 ms. GPU and encoder load are the same within the noise:
nvidia-smi reports the whole card, the numbers jump around from run to run (other work was running on this
PC), and the encoder percentages are of a card that is nearly idle. On a still screen the engine's bitrate is
simply lower (its constant-bitrate encoder doesn't pad a quiet picture; FFmpeg's does), which is less to
upload and no loss. On a busy picture both sit at the chosen 6000: a 45 s run of a hard test pattern at
6000 averaged 6009, at 8000 averaged 8072. FFmpeg has B-frames (so better compression); the engine can't on
NVIDIA (see below), so FFmpeg's picture may look a little better at the same bitrate. Nobody compared looks.

Also checked: 3.5 minutes of 1080p60 with a moving picture and sound through a pipe held steady at 77 to 81 MB
and 650 to 657 handles (a longer run wasn't done); the sound through a pipe made by .NET the way the Uncbox
app makes it arrives intact (tone at the right level, audio and video ending within 12 ms of each other);
`q` ends it in under 60 ms; a dead server, a closed sound pipe, an unreachable address and a bad screen
number each end it with one plain sentence and exit code 1; `rtmps://` works through Windows' TLS against
a local TLS endpoint (with a self-signed certificate trusted through the test-only variable below) and
refuses one it doesn't trust.

Two things only used for testing: `UNCBOX_STREAM_DEBUG=1` prints what the engine is doing (key filtered,
as everything is), and `UNCBOX_STREAM_TLS_ROOT=<certificate file>` adds one certificate to those Windows trusts,
so a local test server with its own certificate can be used. Neither is set in normal use.

## What isn't done, or isn't known

- **NVIDIA's encoder takes no B-frames through Media Foundation** (`AVEncMPVDefaultBPictureCount` is
  "not implemented" by it), so on NVIDIA the stream is I and P only. Other encoders get 2 B-frames if
  they accept the setting; the time stamp handling for them (decode times, delayed sound) is unit
  tested but could not be run against a real encoder here. Direct NVENC, which has B-frames, isn't
  built.
- **AMD and Intel are untested.** The code path is the same Media Foundation one, found per graphics
  card, but there is no AMD or Intel card on the test PC. The synchronous (non-"async") encoder path
  they might use is written and unit-untested.
- The encoder runs on the card that owns the screen. A laptop whose screen hangs off the Intel chip
  while the NVIDIA card renders isn't supported (it says so, and FFmpeg has the same limit).
- HDR screens, and a screen whose size changes mid-stream, end the stream with a plain message (the
  page starts it again for a size change). Rotated screens are sent as Windows gives them.
- The encoder's "constant" bitrate isn't strictly constant: on a very busy picture it runs 7 to 13
  percent over, so the engine aims at 93 percent of the chosen rate (averages 6009 kbps for a 6000
  target over 45 s on a hard test pattern, but 15 s windows range from 4960 to 6530). On a quiet
  screen it simply uses less.
- Not built, on purpose: other services, recording to a file, a second output, overlays composited on
  the card. `settings.rs`, `flv.rs` (which can already write a file) and `pipeline.rs` are laid out so
  each slots in.
