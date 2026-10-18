# Discord RPC approval

Uncbox's voice panel talks to the Discord desktop app over Discord's local RPC. The voice
permissions it needs (`rpc.voice.read`, `rpc.voice.write`) are restricted: Discord has to approve
an app before anyone other than its listed testers can use them.

This page has two parts:

1. **Set up the official Uncbox app.** Do this now. It removes the "make your own developer app"
   step for you and up to 50 testers, with no approval needed.
2. **The approval request.** Send it when Uncbox is closer to release.

Expect a long wait or a no. Discord documents RPC as a closed beta, recommends its Social SDK
for new projects, and publishes no application form for these scopes. At least one other developer
was told these scopes are generally not being granted. Part 1 works either way.

---

## Part 1: The official Uncbox Discord app

1. At [discord.com/developers/applications](https://discord.com/developers/applications), create
   an application named **Uncbox**. Owning it through a Discord **Team** makes it easier to hand
   over or share later.
2. Under **General Information**, add the app icon and a one-line description.
3. Under **OAuth2**:
   - Turn on **Public Client**. Uncbox then signs in with PKCE, so no secret ships with it.
   - No redirect is needed up front. If Discord asks for one during sign-in, the Discord panel
     says so and offers `http://localhost` to copy.
4. Under **App Testers**, invite each Discord account that should be able to use the voice panel,
   up to 50. Each person accepts the invite in Discord. You don't need to list yourself if you
   own the app.
5. Copy the **Application ID** into `server/discord-app.json`:

   ```json
   { "clientId": "YOUR_APPLICATION_ID" }
   ```

   An application ID is public, so it is safe to commit. Never put a client secret in this file.

After that, the Discord panel skips setup entirely and shows **Connect Discord**. Accounts that
aren't testers see "This Discord account is not a tester on the Uncbox app yet."

---

## Part 2: The approval request

**Where to send it:** Discord's support portal at
[support.discord.com/hc/en-us/requests/new](https://support.discord.com/hc/en-us/requests/new)
(also reachable as `dis.gd/contact`). Sign in with a Discord support account, choose **Developer
Support**, then the topic closest to "app permissions / scopes". The categories change over time,
so pick the best fit when you get there.

**Before you send it, have ready:**

- [ ] The Uncbox app from Part 1, with icon, description, and Public Client on
- [ ] A **Privacy Policy** URL and a **Terms of Service** URL (Discord asks for both when
      reviewing apps; a short page on GitHub Pages is fine)
- [ ] A 30–60 second screen recording of the voice panel: connecting, members lighting up as they
      speak, joining a pinned channel, mute/deafen
- [ ] Two or three screenshots of the panel in different presets

### Request text

Fill in the bracketed parts, then paste.

> **Subject:** RPC scope approval for Uncbox (rpc, rpc.voice.read, rpc.voice.write)
>
> **Application ID:** [APPLICATION ID]
> **Application name:** Uncbox
> **Contact:** [YOUR NAME], [EMAIL]
>
> Hello,
>
> I'm requesting approval for the `rpc`, `rpc.voice.read` and `rpc.voice.write` scopes for
> Uncbox, a desktop streaming dashboard. Streamers run it on their own PC to keep their game,
> Twitch chat, run stats and Discord voice on one screen while they play and broadcast.
>
> **What Uncbox does with Discord**
>
> Uncbox has a voice panel that connects to the user's own Discord desktop client over local IPC.
> After the user approves the AUTHORIZE prompt in Discord, the panel:
>
> - shows the members of the voice channel the user is currently in, with speaking indicators
>   and mute/deafen state (`GET_SELECTED_VOICE_CHANNEL`, `VOICE_STATE_*`, `SPEAKING_START/STOP`,
>   `VOICE_CHANNEL_SELECT` subscriptions);
> - lets the user mute, deafen, or leave voice without switching to Discord
>   (`SET_VOICE_SETTINGS`, `GET_VOICE_SETTINGS`, `SELECT_VOICE_CHANNEL` with a null channel);
> - lets the user pin voice channels from their own servers and join them with one click
>   (`GET_GUILDS`, `GET_CHANNELS`, `SELECT_VOICE_CHANNEL`).
>
> Every action is something the user starts themselves, on their own account, on their own PC.
> Uncbox never joins a channel, mutes, or deafens without a direct click.
>
> **Why these scopes**
>
> - `rpc`: required for the local RPC connection and the guild/channel lookups.
> - `rpc.voice.read`: the member list, speaking indicators, and the user's own mute/deafen state.
> - `rpc.voice.write`: joining and leaving voice channels and toggling mute/deafen from the panel.
>
> No other scopes are requested. Uncbox does not read messages, notifications, or relationships.
>
> **Data handling**
>
> - Uncbox has no backend. Everything runs on the user's machine.
> - The app is a Public Client and uses PKCE, so no client secret is distributed.
> - OAuth tokens are stored only in a local file on the user's PC and are sent only to Discord.
> - Voice state is shown on the user's own screen. It is not logged, stored, or sent anywhere.
>   It can appear on the user's stream only because the user chose to capture their own screen.
>
> **Why not the Social SDK**
>
> The voice panel works with the voice channels in the user's existing Discord servers: the ones
> they and their friends already use. As far as I can tell, the Social SDK's voice features are
> built around game lobbies rather than guild voice channels, so it doesn't cover this use.
>
> **Status**
>
> Uncbox is in development and is currently used by its author and [N] listed App Testers. A demo
> video and screenshots are attached. Privacy Policy: [URL]. Terms of Service: [URL].
>
> I'm happy to adjust anything about how the app requests or uses these permissions.
>
> Thank you,
> [YOUR NAME]

### If they say no

The voice panel keeps working for the app's testers, up to 50 people. For a public release
beyond that, the panel can fall back to each user entering their own app's Client ID. That flow
is already built in Uncbox, and with Public Client on it needs no secret.
