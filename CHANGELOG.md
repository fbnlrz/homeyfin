# Changelog

All notable changes to Homeyfin are documented here. The format roughly
follows Keep a Changelog; dates are not pinned while pre-1.0.

## [Unreleased]

### Changed (app name & id)
- Renamed the app to **"Media Control for Jellyfin"** (id
  `com.frlrnzn.mediacontrol`). Homey forbids "Homey" in the app name, and the
  "… for Jellyfin" affix is the form Jellyfin's own branding guidelines
  explicitly permit for unofficial third-party apps (own logo, no
  `org.jellyfin` namespace, unofficial disclaimer — all satisfied). The hero
  wordmark and store texts were updated to match.

### Added / Changed (visuals)
- **Capability icons**: every custom capability now ships a monochrome
  single-path icon (`assets/capabilities/*.svg`) referenced via `icon`.
  Previously the device pages showed dashed empty-box placeholders because
  custom capabilities had no icon.
- **App Store image & driver tiles** redesigned. The app image is now a
  proper "Now Playing" hero (poster fan + now-playing card + library stats)
  instead of a plain play button, per Homey App Store guideline 1.4; the
  server/user driver tiles get matching branded emblems. Rendered from
  `scripts/design/*.html` via `scripts/render-store-images.mjs`.

### Fixed (SDK-compliance / Homey Apps SDK guidance)
- **App & driver icons** rewritten as a single solid `<path>` with
  `fill-rule="evenodd"`. The previous icons used a `<linearGradient>` inside
  `<defs>`, which Homey's monochrome icon renderer silently drops — the icon
  showed up as an empty coloured disc.
- **Timers** in both device classes now use `this.homey.setInterval` /
  `setTimeout` / `clearInterval` / `clearTimeout` instead of the Node globals,
  so they are auto-cleared on app destroy.
- **`onUninit()`** added to the server and user devices to tear down timers and
  detach hub listeners on app shutdown/reload (previously only `onDeleted()`).
- **`onSettings()`** now reads the fresh `newSettings` values instead of
  `getSettings()` (which still returns the OLD values while the handler runs),
  so changed poll intervals / TLS flag / refresh cadence / summary hour take
  effect immediately instead of only after the next restart.

## [1.0.0] - 2026-06-07

First public release.

### Added (second feature batch)
- **Chapter navigation**: action *Skip chapter* (next / previous) using
  the item's chapter data — handy for intros and credits.
- **Queue management**: actions *Add to queue* (PlayNext / PlayLast),
  *Clear queue / stop*.
- **Server admin actions**: *Restart Jellyfin server* and *Shut down
  Jellyfin server* (require an admin API key).
- **Health-check action** with ok / version / server / latency tokens.
- **Bookmark action**: adds the current item to a Jellyfin playlist
  (auto-created on first use, default "Homey Watchlist").
- **Random with genre filter**: `play_random` now takes an optional
  genre autocomplete in addition to the type dropdown.
- **Daily summary trigger** at a configurable hour with
  minutes-today / minutes-week tokens.
- **Capabilities**: server `server_uptime` (minutes), user
  `watch_minutes_week` (auto-resets weekly, persisted across restarts).
- **Volume cap setting** (per user device) — caps the volume Homey will
  send to Jellyfin, useful as a parental control.

### Changed
- `JellyfinClient` gains an LRU image cache (`getCachedImage`) used by
  album-art / poster streams so the Jellyfin server isn't hit on every
  widget refresh.
- `JellyfinClient` API extended with `getItem`, `getGenres`,
  `getPlaylists`, `createPlaylist`, `addToPlaylist`,
  `restartServer`, `shutdownServer`, `getSystemInfoFull`, `ping`.



### Added
- **Playback control**
  - Action: *Play item* with autocomplete search against the Jellyfin library.
  - Action: *Play random* movie or episode.
  - Action: *Resume Continue Watching* — picks up where the user left off.
  - Action: *Seek to position* (seconds) and *Skip forward/back* (signed delta).
  - Action: *Set audio track* / *Set subtitle track* with per-item autocomplete.
  - Action: *Mark current item as watched*.
  - Action: *Toggle favorite on current item*.

- **Triggers**
  - *Minutes before end* — fires once per item when the remaining time crosses
    the configured threshold.
  - *Progress reached X %* — fires once per item per milestone (1..99).
  - *Transcoding started* / *Transcoding stopped* on the server device.
  - *Server connection restored* / *Server connection lost*.
  - *Active streams changed* with count + transcoding token.
  - *User logged in* now has a user-name autocomplete filter (or "Any user").
  - *New item added* now has a library autocomplete filter and a poster
    image token (usable in Homey push notifications).
  - *Playback started* exposes a poster image token.

- **Conditions**
  - *Active streams is/is not above N*.
  - *User is/is not transcoding*.

- **Capabilities**
  - Server: `stream_count`, `transcoding_count`, `socket_online`.
  - User: `is_transcoding`, `unwatched_count`, `continue_watching_title`.

- **Reliability**
  - Smart session polling: idle = no polling, active = 5 s alongside the
    socket (configurable), socket-down = 30 s fallback (configurable).
  - HTTPS self-signed certificate option in server settings.

### Changed
- ServerHub now exposes `getStreamCount`, `getTranscodingCount`,
  `pickActiveSnapshot` and emits `connection:up`/`down`, `streams:count`,
  `transcoding:started/stopped` events.

## 0.1.0

- Initial implementation: Jellyfin server + user devices, library counters,
  playback control, two widgets (server overview, now playing), repair
  flow, persistent "new item" cache.
