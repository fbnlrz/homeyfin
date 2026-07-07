Media Control for Jellyfin — Unofficial Jellyfin integration for Homey

Not affiliated with or endorsed by the Jellyfin Foundation. Jellyfin is a
trademark of the Jellyfin Foundation; this is an unofficial third-party client.

WHAT IT DOES

Control your Jellyfin media server and its users from Homey. Each Homey device
represents one Jellyfin user, and playback commands automatically follow the
user to whichever client they are currently watching on — the living-room TV in
the evening, a phone on the go.

DEVICES

Jellyfin Server — library counts (movies, series, episodes), latest added title,
active streams and transcodes, connection state, uptime and scan status.

Jellyfin User — now-playing title and details, position and duration, volume,
album art, unwatched episode count, continue-watching title, weekly watch
minutes, online and transcoding state.

FLOWS

Triggers: playback started, paused, resumed, stopped and changed; progress
milestones and minutes before the end; new library item (with poster); library
scan finished; user logged in; transcoding started or stopped; active streams
changed; server connected or lost; daily summary.

Conditions: is playing, media type is, is transcoding, active streams above N.

Actions: play and pause, seek, skip chapter, set audio and subtitle track, add
to queue and clear it, play an item, play something random, resume continue-
watching, mark watched, toggle favorite, bookmark to a playlist, send a message
to the client, start a library scan, restart or shut down the server, health
check.

WIDGETS

Server overview — live streams, library totals and per-stream cards with
progress and a transcoding badge.

Now playing — poster with a scrubbable progress bar and a full control row.

SETUP

1. In Jellyfin, create an API key (Dashboard, API Keys).
2. In Homey, add the Jellyfin Server device, enter the server URL and API key,
   test the connection and pick a default user.
3. Add one Jellyfin User device per person.
4. Add the widgets to your dashboard.

Author: Fabian-René Lorenzen
