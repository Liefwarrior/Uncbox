# Streaming with Uncbox

Uncbox can go live on Twitch by itself, without OBS. It captures one screen, encodes it on your
graphics card and sends it to Twitch. There is nothing to tune: Uncbox finds your card's encoder
and the quickest way to scale the picture on its own. It streams with Uncbox unless you pick OBS
(anyone who already picked OBS keeps it).

## What you need

- A Windows PC with an **NVIDIA, AMD or Intel graphics card** and a current driver. Uncbox uses
  the card's own video encoder (NVIDIA NVENC, AMD AMF or Intel Quick Sync), so the game keeps the
  processor.
- **FFmpeg**. If it isn't installed, the Streaming section says so and has an **Install FFmpeg**
  button (the same install the Downloads widget does).
- To stream your sound, run the **Uncbox app** (`npm run app` or the installed one). Windows
  plays your desktop sound where a web page can't reach it; the app records it and your mic and
  gives them to the stream. In a plain browser the stream is picture only, and says so.
- A Twitch account.

## Set it up

Sign in to Twitch in a Twitch widget. That is the whole setup: Uncbox reads your stream key from
the sign-in the first time you open **Streaming** or press **Go live**. Everything below is optional.

1. **Stream key.** Picked up from the Twitch sign-in on its own. You can also **Paste stream key**
   (Twitch: Creator Dashboard, Settings, Stream, Primary Stream key) or press **Get it from Twitch**.
   If it says to sign in again, do that once: Twitch needs one more permission to read the key. The key stays on this PC in `data/stream.json`. Uncbox shows only its last four
   characters (and not even those while you are on air), and never puts it in your settings,
   exported presets or anything it sends to the page.
2. **Screen.** Which monitor to capture: Screen 1 is your main one.
3. **Quality.** `1080p60 · 6000` suits most connections. Lower ones (`720p60 · 4500`,
   `720p30 · 3000`) need less upload. **Screen size** sends the screen as it is.
4. **Sound** (in the app). **Desktop sound** is what Windows plays. **Mic** picks a microphone,
   or **No mic**. The sliders go from silent to double volume, and while you are live a small
   bar under each shows how loud it is.

The last line of the section says whether this PC is ready, naming the encoder it found ("Ready:
NVIDIA NVENC on your graphics card"), or what is missing.

## Try it first

**Test stream (not public)** sends the stream to Twitch as a bandwidth test. Twitch takes it but
shows it to no one, so you can check the picture, sound and numbers without going live.

## Go live

Press **Go live** (it asks once more: **Go live?**). The line under the button counts your time:

    ● Live 1:02:33 · 5.9 Mbps · 0 dropped

**End stream** (also two clicks) stops it. Ctrl+K has **Go live**, **Test stream** and **End
stream** too.

While you stream from Uncbox, **On air** is forced on, like with OBS, so mail, calendar, file
names and paths stay off the screen you are sending.

If the connection drops, Uncbox tries again after 2, 4, 8, 16 and 30 seconds with fresh sound,
and gives up after five tries in a row, telling you why. If the sound stops, the stream ends rather
than carry on silent.

## How light it is

Uncbox does the heavy work on the graphics card's video encoder, which games barely use, and runs
FFmpeg above normal priority so a game that takes every core can't make the stream stutter.
Measured on an RTX 5090 laptop, streaming a 2560×1440 screen at `1080p60 · 6000`:

| | Before | Now |
|---|---|---|
| Frames sent | about 56 a second | 60 a second |
| Processor time | about 83% of one core | about 25–38% of one core |
| Scaling | on the processor (bicubic) | on the graphics card (CUDA, Lanczos) |
| Video encoder busy | 7% | 5–7% |

The picture is scaled with CUDA on NVIDIA cards, AMF on AMD and Quick Sync on Intel, falling back
to the processor only where none of those work. NVENC runs at its quality end (a quarter-size
first pass, adaptive quantisation and 20 frames of look-ahead), which modern cards do with room
to spare and which shows most at Twitch's bitrates.

## What viewers see

The screen you picked, as it is: one picture, with no scenes, overlays or camera layout. Anything
on that screen is on stream, including Uncbox itself, so use stream mode (F8) or capture a screen
with only the game. Need scenes and overlays? Use OBS, as before.

## If it won't start

- **No stream key yet.** Add one under Streaming.
- **FFmpeg isn't installed.** Use **Install FFmpeg**, then **Check again**.
- **No encoder.** Uncbox needs the video encoder on an NVIDIA, AMD or Intel graphics card. Update
  the graphics driver.
- **Dropped right away.** The line under the button shows the last thing FFmpeg said, with the
  key blanked out. Twitch refusing the key is the usual cause: copy it again.
