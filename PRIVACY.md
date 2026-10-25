# Privacy policy

**Short version: there is no Uncbox server and no central database. Anything Uncbox makes or
saves stays on your device.**

Uncbox runs entirely on your own PC. Nobody who makes Uncbox can see your data, because none of
it is ever sent to us. There's no account to make, no analytics, no tracking and no ads.

## What stays on your device

- Your layouts, presets and settings: the `data` folder next to Uncbox.
- Sign-ins (Google, Twitch, Discord, OBS) and their tokens: also in `data`, on your PC only. They
  are never sent to the Uncbox page in full, never shared, and never leave your PC except to the
  service they belong to.
- Clips and downloads: your Videos folder (`Videos\Uncbox`).

Delete the `data` folder and it's all gone.

## What Uncbox connects to

Uncbox only talks to a service when you turn on the widget that needs it. It talks to that service
directly from your PC. Nothing goes through a server of ours, because there isn't one.

| When you use | Uncbox talks to | What for |
| --- | --- | --- |
| Google widgets (Calendar, Gmail, Drive) | Google, with your own Google Cloud client | Your calendar, mail headers (not mail text) and files, shown on your screen. Clips upload to your Drive only if you turn that on |
| Twitch | Twitch | Chat, read without signing in; with sign-in, your stream's title, category and numbers |
| Discord | The Discord app on your PC, and Discord | Your voice channel (who's in it and talking); clips to a webhook you set |
| OBS | OBS on your PC | Scenes and starting or stopping your stream |
| Steam | Steam on your PC, and the Steam store | What you're playing, and game art |
| Weather | Open-Meteo | The forecast for the place you type in |
| Video downloads | The site you paste a link from | Downloading that video, using yt-dlp |
| Updates and the preset gallery | GitHub | Checking for a new version, and fetching shared presets |

Each of those services has its own privacy policy, which covers what it does with your requests.

## Google user data

Uncbox's use of information received from Google APIs follows the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Google data is shown to you on your own screen and stored
only on your PC. It isn't sold, shared, used for ads, or used to train AI models.

## Changes

If this ever changes, this file changes with it, in the open, in this repository.

Questions: open an issue at [github.com/Liefwarrior/Uncbox](https://github.com/Liefwarrior/Uncbox/issues).
