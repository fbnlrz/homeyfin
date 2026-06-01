# Changelog

All notable changes to Homeyfin are documented here. The format roughly
follows Keep a Changelog; dates are not pinned while pre-1.0.

## [Unreleased]

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
