# Going live with Uncbox

A short checklist for streaming with Uncbox on screen. What is hidden while you are live, and why,
is in [stream-privacy.md](stream-privacy.md).

## The day before

- Start Uncbox the usual way (`npm run app`), pick your game's preset, and play one match with it.
  If a panel is empty or wrong, fix it now rather than live.
- Sidebar names are public too: rename any custom preset whose name you would not read out.
- Panels that are not connected (Discord, Camera) vanish in stream mode and leave a gap. Connect
  them, or take them off the board (the × in **On screen**).
- So that going live hides personal info by itself, connect OBS: in OBS, **Tools → WebSocket Server
  Settings**, turn it on and copy the password; then add the **OBS** widget in Uncbox and paste it.
- Optional: in **Automations**, turn on **When OBS goes live, turn on stream mode**.

## Right before you go live

- Close Uncbox and start it again, so you are on the latest version and nothing is left over.
- Click **Off air** under Stream mode so it reads **On air: personal info hidden**. It stays on until
  you click it again, and it is forced on whenever OBS is live or stream mode is on.
- Check the board once in stream mode (the button, F8 or Esc to come back).
- Save a test clip (the clip key, `=` by default) and play it back.

## While live

- Leaving stream mode to show the sidebar or Get More Widgets is safe: **On air** keeps mail,
  calendar, file names and paths hidden.
- Web and App window panels show whatever the page or app shows. Uncbox cannot hide what is inside
  them, so don't open private pages in them on stream.
- Avoid switching to the WoW preset on stream: the first time, it installs the WoW addons and says
  so in a toast.
- If something misbehaves: Esc out of stream mode, or close and start Uncbox again. Your layout is
  saved, and `data/state.json.bak` holds the last good copy.
