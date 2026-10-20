# Roadmap

Where Uncbox is headed: one dashboard for **streaming, gaming, browsing and productivity**, so the
second monitor (or the whole screen) never needs another app. Tickets are numbered `UBX-n`; each
lists what done looks like. Status is one of **Building**, **Review**, **Shipped** (with the
commit), or **Queued**. Loose ideas that are not tickets yet live in [ideas.md](ideas.md).

## Wave 1: building now

### UBX-1 · Google Drive widget — Shipped (b1c95e1)
Browse and open your Drive from a widget: Recent, Starred, Shared with me, Search, thumbnails.
- Sign in with Google from Uncbox (installed-app OAuth with PKCE, your own Desktop OAuth client),
  tokens kept server-side in `data/google.json`, never sent to the page.
- A reusable `server/google.mjs` so Calendar and Gmail (UBX-9, UBX-11) reuse the sign-in.
- Works without signing in when Google Drive for desktop is installed (browses `G:\My Drive`).
- Done when: a signed-in widget lists recent files and opens one; signing out revokes the token.

### UBX-2 · Web widget — Shipped (0afc6c5)
A browser inside a panel: address bar, back/forward/reload, Open in browser, zoom, hide toolbar.
- In a plain browser: an iframe, with a friendly "this site can't be shown here" card for sites
  that refuse framing.
- In the Uncbox app: a real WebView2 laid over the panel, so any site works (Google Docs,
  YouTube, dashboards), with sign-ins that persist.
- Done when: several web widgets show different sites in the app and stay put while panels move.

### UBX-3 · OBS widget — Shipped (3b1e193)
Stream health and control over obs-websocket v5: LIVE/REC with timecodes, bitrate, dropped
frames, CPU/FPS, scene buttons, start/stop stream and record (stop asks first), mic mutes, save
replay buffer. Password kept server-side.
- Done when: the widget shows live status from OBS and switches scenes.

### UBX-4 · Focus timer and Launcher widgets — Shipped (dac0305)
- **Focus**: a Pomodoro timer that survives reloads, with a soft chime and break colours.
- **Launcher**: a dock of apps, folders, files, websites and Steam games. The server only ever
  launches tiles you saved (never an arbitrary path from the page); icons from the apps.
- Done when: a tile launches its app and a focus round chimes at the end.

### UBX-5 · Ping & FPS widget — Shipped (6327242)
Live ping (TCP connect timing, no admin), jitter, loss and a sparkline, plus game FPS, 1% lows and
in-game ping read from SMITE 2's performance timeline when a match is on. Sampling runs only while
a widget is showing.

### UBX-7 · Now playing gets controls — Shipped (6f508a0)
Album art, a live progress bar, and previous/play-pause/next/seek for Spotify, browsers and
anything in the Windows media flyout.

### UBX-8 · Installer, start with Windows, update notice — Building
`Uncbox.exe` installs itself per user (Start menu, uninstall entry, no admin), an optional "Start
Uncbox when Windows starts", and a quiet "a new version is out" notice from GitHub releases.

## Wave 2: queued (start as wave 1 lands)

### UBX-6 · Desk preset — Queued (after UBX-1, 2, 4)
A built-in "Desk" preset for working between games: Drive, Web, Focus, Launcher, Calendar, Now
playing, Notifications, Clock/Weather, with its own calm theme.

### UBX-9 · Google Calendar widget — Queued (after UBX-1)
Today and the next few days from your calendars, "starts in 10 min" highlight, join-meeting
button for Meet links; reuses the Google sign-in with incremental consent.

### UBX-10 · Save clips to Google Drive — Queued (after UBX-1)
A "Save to Drive" button in the clip player (and an option to upload every clip automatically)
into an "Uncbox Clips" folder, resumable uploads, a share link copied when done.

### UBX-11 · Gmail glance — Queued (after UBX-1)
Unread count and the latest few subjects/senders, click to open in the Web widget or browser.

### UBX-12 · Command palette — Queued (after UBX-1, 2, 4)
Ctrl+K anywhere in Uncbox: switch presets, add widgets, launch Launcher tiles, search Drive, open
a URL in a Web widget, save a clip, toggle stream mode.

### UBX-13 · Twitch stream info — Shipped (a51aca9)
Viewer count, followers/subs as they happen, edit title and category from Uncbox (Twitch sign-in
kept server-side, like Google).

### UBX-14 · Community preset gallery — Queued
Browse and install shared `.uncbox` presets from inside Uncbox (a GitHub-hosted index to start).

### UBX-15 · Screen reading for more games — Queued
Ready-made readers like the SMITE 2 one: Pokémon party HP and fainted markers, an automatic death
counter.
