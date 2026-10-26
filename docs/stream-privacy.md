# Nothing private on stream

When you stream or record, everything Uncbox draws is public. Uncbox keeps personal things (mail, calendar, file names, folders, addresses) off the screen whenever you might be on air. This is separate from the **stream mode view** (full screen, edit controls hidden): you can leave stream mode to show the sidebar and library and still be safe.

## When it is on

"Private" is on when any one of these is true:

| Signal | How it turns on |
| --- | --- |
| Stream mode view | The sidebar's **Stream mode** button, or F8. |
| OBS is live | OBS is streaming (or reconnecting) or recording. Uncbox reads this from OBS by itself; it needs the OBS WebSocket connection (see the OBS widget). |
| Streaming from Uncbox | Uncbox is starting a stream, live, or trying to get a dropped one back (a test stream too: it captures the same screen). The pill says **Streaming from Uncbox, so it stays on**. See [streaming-with-uncbox.md](streaming-with-uncbox.md). |
| **On air** switch | The pill under the Stream mode button: **On air: personal info hidden** or **Off air**. It is remembered in this browser. While OBS is live or stream mode is on, it shows it is forced on and the click does nothing. |

Use the **On air** switch when you go live without OBS reporting it (a screen share, a call, a window capture) or when you want to be safe before you press Start in OBS.

In code, every widget asks one thing: `usePrivate()` from `src/privacy.tsx`. Counts and status stay; names and text go.

## What is hidden

| Where | Hidden while private | Opt-in to show it |
| --- | --- | --- |
| Gmail | Who wrote and the subjects. The unread count stays. The label name is hidden. | Widget settings: **Show on stream** |
| Calendar | Event titles, places, attendees, Join links. Only "Busy until 3:00 PM" or "Free" shows. | Widget settings: **Show on stream** |
| Drive | File names, thumbnails, owners, and the signed-in account. The panel says files are hidden. Nothing is even asked of Drive. The sign-in account view says "your Google account" instead of the address. | None |
| Notifications | Only the app's name ("Discord"). Never the title or message, even with "Show the message" on. | None |
| Launcher | The path or link while you type it in the tile form is dots. Tile names are labels you chose, so they stay. Paths never reach the page when a tile opens. | None |
| Web | The address bar shows only the site (`mail.google.com`), also in its tooltip and the frame's title. The home page you type in settings is dots. **The page itself still shows what it shows**: Uncbox cannot hide the inside of a web page. | None |
| Twitch | Stream info is public anyway. The Client ID you paste in setup is dots. | None |
| Now playing | When a web browser is playing, only "Playing in a browser" (a tab's title can be a private page). Music apps like Spotify show as usual. | None |
| Steam | The account name and picture. Games stay. | None |
| Weather | The place name ("Local weather" instead). | None |
| OBS | The host you type under Connect to OBS is dots (the password always was). Scene and source names stay. | None |
| Video downloader | The video's title and address become "A video from example.com", also in the tooltip. The address box is dots. Error messages drop folders and addresses. | None |
| Auction House | Your gold, sales and purchases (Overview, Selling, Accounting). Item prices stay. | Widget settings: **Show gold on stream** |
| Guild roster | Officer notes always. Public notes. | Widget settings: **Show notes on stream** (public notes only) |
| Guild feed | Who left or was demoted. | Widget settings: **Show who left or was demoted on stream** |
| Raid loot, Attendance | Player names become "Member 1", "Member 2". | Widget settings: **Show names on stream** |
| Streaming (sidebar) | The last characters of the stream key ("Stream key set ····abcd" becomes "Stream key set"). | None |
| Clips (sidebar) | The clips folder path (tooltip), the last characters of the Discord webhook, the title of a downloaded video. Errors drop folders and addresses. | None |
| Clip player and clip toast | A downloaded video's title. Error and "not on Drive" messages drop folders and addresses. | None |
| Toasts (Undo, notices) | Any email address becomes "an email address"; any folder path becomes "a folder on this PC". | None |
| Ctrl+K palette | Drive results (and Drive is not searched). | None |

## Left as is, on purpose

Game panels, counters, chat, Discord voice names, Notes and Text widgets, Clock, System, Network, Camera, Focus and the other game widgets are things you put on screen for viewers, so they are not touched. The **App window** widget shows the window you picked and **Web** shows the page it opened: Uncbox cannot see what is inside them, so keep a private page out of those panels.

## Adding a widget

If your widget shows anything about the person (names, mail, paths, addresses, accounts), call `usePrivate()` and leave that out while it is true. Give a widget an opt-in only if viewers might reasonably want to see it. Add a row to the table above and a case to the "private" tests in `src/smoke.test.tsx` (put a `SENTINEL_` string in the fake data in `src/smokeMocks.ts`).
