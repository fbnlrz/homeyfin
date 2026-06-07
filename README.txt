Homeyfin — Unofficial Jellyfin integration for Homey

Note: This app is not affiliated with or endorsed by the Jellyfin Foundation.
Jellyfin is a trademark of the Jellyfin Foundation; this is an unofficial
third-party client.

WHAT IT DOES
============

Homeyfin lets you control your Jellyfin media server and its users from
Homey. The integration is user-centric: each Homey device represents
one Jellyfin user, and playback commands automatically route to whichever
client the user is currently active on (living-room TV in the evening,
phone on the go, etc.). There is no per-client device juggling.

DEVICES
=======

Jellyfin Server (one per server)
  Library counters (movies / series / episodes), "latest added" title,
  stream count and transcoding count, connection state, server uptime,
  library scan in progress.

Jellyfin User (one per user)
  Now-playing title, subtitle, position, duration, track / artist / album
  for sonos-compatible flows, album art on the mobile app, unwatched
  episodes count, "up next" continue-watching title, weekly watch
  minutes, online state, transcoding state.

TRIGGERS
========

Server:
  - New item added to library (filter by type / library, includes a
    poster image token usable in Homey push notifications)
  - Library scan finished
  - User logged in (filter by user)
  - Transcoding started / stopped
  - Active streams changed
  - Server connection restored / lost

User:
  - Playback started / paused / resumed / stopped / now-playing changed
  - Minutes before end (e.g. dim lights 5 min before credits)
  - Progress reached N % (1..99 milestones)
  - Daily summary at a configurable hour, with minutes-today and
    minutes-this-week tokens

CONDITIONS
==========

  - Is / is not playing
  - Media type is / is not (Movie, Episode, Audio)
  - User is / is not transcoding
  - Active streams above N

ACTIONS
=======

Playback control:
  - Seek to absolute position, skip forward / back any amount
  - Skip to next / previous chapter (uses chapter data, perfect for
    intros and credits)
  - Set audio track, set subtitle track
  - Add to queue (PlayNext / PlayLast), clear queue
  - Play item (autocomplete search through the library)
  - Play random (with type and genre filter)
  - Resume Continue Watching

Library:
  - Start library scan (with library autocomplete)
  - Mark current item as watched, toggle favorite
  - Bookmark current item to a Jellyfin playlist (auto-created)

Server admin:
  - Restart server, shutdown server (admin API key required)
  - Health check (returns version, latency, ok flag)

Per user:
  - Send message to the client the user is on

WIDGETS
=======

Server overview
  Live stream count, library totals, per-stream cards with user avatar
  initials, poster, progress bar, transcoding badge, and an equalizer
  animation while a stream is playing. Light and dark theme aware.

Now playing
  Big poster with a blurred backdrop, scrubbable progress bar (drag to
  seek), full control row: previous chapter, -10s, play/pause, +10s,
  next chapter. Quick buttons for favorite and mark-watched.

RELIABILITY
===========

  - Single shared WebSocket per server, with automatic reconnect and
    exponential backoff
  - Smart polling: idle = none, active = parallel low-latency polling
    alongside the socket, socket-down = slower HTTP fallback
  - Persistent "new item" cache so app restarts don't fire stale
    trigger events
  - Stopped-trigger debounce against brief network blips or client
    switches
  - HTTPS self-signed certificate support for LAN servers
  - Repair flow so you can rotate the API key without losing the
    device or any attached flows

SETUP
=====

1. In Jellyfin, create an API key:
   Dashboard -> API Keys -> + (New API Key)

2. In Homey, add the Jellyfin Server device:
   Devices -> Add -> Homeyfin -> Jellyfin Server
   Enter the server URL (e.g. http://192.168.1.10:8096) and the API key,
   tap "Test connection", pick the default user, then "Add device".

3. Add one Jellyfin User device per family member:
   Devices -> Add -> Homeyfin -> Jellyfin User
   Pick the server, load the user list, pick the user.

4. Add widgets to your dashboard from the widget gallery.

DEVELOPMENT NOTE
================

This app was vibe-coded with Claude Code (Anthropic) as a development
companion: design, implementation, bug audits and the App-Store prep
were iterated dialogically across a single session, with human review,
real-hardware testing after every change, and the final architecture
calls staying with the author. The source is open — if you find a bug
the AI-and-human pair didn't, please open an issue.

CREDITS
=======

Source: https://github.com/fbnlrz/homeyfin
Issues: https://github.com/fbnlrz/homeyfin/issues
Author: Fabian-René Lorenzen <frlrnzn@gmail.com>
Built with: Claude Code (Anthropic Opus 4.7)
