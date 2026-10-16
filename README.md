# PokéStream

A stream dashboard you host on your own PC: one big window for the game, with smaller panels
around it for your camera, party, run timer, progress and notes. Built for Pokémon runs, but
nothing in it is tied to a particular game, generation or platform.

```
┌──────────────────────────────────────────┬──────────────┐
│                                          │   Camera     │
│                                          ├──────────────┤
│                 Game                     │              │
│   (capture card, emulator window,        │    Party     │
│    or a chroma slot for OBS)             │   (1–12)     │
│                                          │              │
├─────────────┬──────────────┬─────────────┤              │
│  Run/timer  │   Progress   │    Notes    │              │
└─────────────┴──────────────┴─────────────┴──────────────┘
```

## Quick start

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

Then open <http://localhost:5170> in Chrome or Edge. `npm start` builds the app and serves it;
`npm run serve` skips the build, and `npm run dev` runs with hot reload while you work on the code.

Everything you change is saved to `data/state.json` (git-ignored) as you go and survives restarts.

## Getting the game into the big window

Hover the game window to show its toolbar, or pick a source from the cards when it is empty.

| Source | Use it for | Notes |
| --- | --- | --- |
| **Capture device** | Switch, 3DS, GameCube… through a capture card | Pick the card from the dropdown. Most cards can only be opened by one app at a time, so if OBS already has it, use the chroma slot instead. |
| **Window** | Emulators (mGBA, melonDS, Dolphin, RetroArch, Citra…) | The browser asks which window to share. It has to ask again after every page reload. |
| **Chroma slot** | Keeping the game capture in OBS | Fills the window with a flat color. Key it out in OBS and put your game capture underneath. Lowest latency option. |

**Crop** trims an emulator's menu bar or a capture card's black bars. **Sharp pixels** keeps
GB/GBA/DS pixel art crisp when it is scaled up. **Fit / Fill / Stretch** chooses how the picture
fills the window.

The dashboard is video only. Capture game audio in OBS as usual.

## Putting it on stream with OBS

1. Open the dashboard in its own window without browser chrome:
   ```bash
   start msedge --app=http://localhost:5170
   ```
   (Chrome works the same way: `start chrome --app=http://localhost:5170`.)
2. Set up the panels, then press **Stream mode** (or `F8`). The sidebar and edit buttons
   disappear; hovering a panel brings its buttons back. `Esc` or `F8` exits.
   Adding `?stream=1` to the URL opens straight into stream mode.
3. In OBS add a **Window Capture** of that browser window.
4. With the chroma slot: add a **Chroma Key** filter to the window capture, set it to the slot's
   color, and put your Game Capture / Video Capture Device source below it.

## Panels

Toggle any panel from the sidebar. When the side column or bottom strip is empty, the game window
takes the space. The sidebar also moves the side column left or right and sizes it.

- **Camera**: a webcam in the browser. Off until you click *Start camera*, so it never fights
  OBS for a webcam it is already using.
- **Party**: 1–12 slots with name, a detail line (level, nature, nickname…), a KO toggle, and an
  image. Click the circle to pick an image, or drag one in from your files or another browser tab.
  Drag the grip to reorder.
- **Run**: game title, challenge/category and a run timer that keeps running across reloads.
- **Progress**: a row of milestones (8 *Badges* by default; rename it and set any count up to 24)
  and as many named counters as you like (deaths, resets, encounters, soft resets…).
- **Notes**: a checklist for goals, rules or reminders.

All text is edited in place: click it and type.

## Controlling it from another device

Every open copy of the dashboard stays in sync, so you can run the streamed window on your PC and
change counters or the party from a phone or a second monitor. By default the server only listens
on this PC. To reach it from your LAN:

```powershell
$env:HOST = "0.0.0.0"; npm start
```

Then open `http://<your-pc-ip>:5170` on the other device. There is no login, so only do this on a
network you trust. `PORT` changes the port the same way.

## Project layout

```
server/index.mjs        local server: static files, /api/state, live sync over /api/events
src/App.tsx             board layout and stream mode
src/state/              state shape, defaults, load/save/sync hook
src/media.ts            capture device, window capture and device list hooks
src/components/         one file per panel, plus the cropping video player
```
