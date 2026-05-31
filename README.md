# homeyfin

Jellyfin integration for Homey (Apps SDK v3, TypeScript).

## Features

- **Server device** – one per Jellyfin server. Surfaces library counts
  (movies / series / episodes), fires triggers when new items are added
  or library scans finish, and provides an action card to start a scan.
- **Client devices** – one per Jellyfin client (TV, mobile app …). Adds
  `speaker_playing`, `volume_set`, `volume_mute`, `speaker_next`,
  `speaker_prev`, plus custom `media_title`, `media_subtitle`,
  `media_position`, `media_duration`, `client_online`. Triggers fire on
  play / pause / resume / stop / now-playing-changed.

## How it works

`lib/ServerHub.ts` opens a single WebSocket per server
(`/socket?api_key=…`) and fans events out to subscribed devices. The
`Sessions` snapshot the server pushes every ~1.5 s is diffed to derive
clean per-client play/pause/stop transitions. `LibraryChanged` triggers
a re-fetch of `/Items/Counts` and `/Users/{id}/Items/Latest`; new IDs
that weren't seen before fire the `new_item_added` trigger.

## Setup

1. In Jellyfin: **Dashboard → API Keys → New API Key**.
2. In Homey: add the **Jellyfin Server** device, enter URL
   (`http://host:8096`) and the API key.
3. Add **Jellyfin Client** devices for each client you want to control.

## Development

```bash
npm install
npx tsc --noEmit              # type-check
npx homey app validate         # validate manifest
npx homey app run              # run against a local Homey Pro
```

### Layout

```
.homeycompose/         # source for app.json, capabilities, flow cards
drivers/server/        # server driver + device (library, scans)
drivers/client/        # client driver + device (playback, now playing)
lib/JellyfinClient.ts  # REST wrapper
lib/JellyfinSocket.ts  # WebSocket wrapper with reconnect + keepalive
lib/ServerHub.ts       # per-server singleton, event fan-out
app.ts                 # owns hub map
```

### Notes before publishing

Add real artwork before submitting to the Homey App Store:
`assets/images/{small,large,xlarge}.png`,
`drivers/<id>/assets/images/{small,large,xlarge}.png`,
and replace the placeholder `assets/icon.svg`.
