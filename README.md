# Homeyfin

Selfhosted Jellyfin integration for Homey. SDK v3, TypeScript — install
directly from source on your own Homey, no App Store required.

PR: https://github.com/fbnlrz/homeyfin/pull/1

> **Built with Claude Code** — this app was completely *vibe-coded*
> with [Claude Code](https://claude.com/claude-code) (Opus 4.7). From
> architecture, implementation, bug audits and pair-flow debugging all
> the way to App-Store-submission prep, every line was iterated
> dialogically in a single session. The human at the wheel: vision,
> feedback after every `homey app run --remote`, and the final calls on
> architecture and scope.
>
> You'll notice the code style and architecture stay consistent end to
> end — that's the result of continuous refactoring (multi-device flow
> listener bug, pair-view cross-state race, stop-debounce, smart
> polling). Bugs welcome via Issues — the human review layer is always
> needed for the edge cases the AI doesn't catch.

---

## At a glance

**Server device** (one per Jellyfin server)
- Library counts: movies, series, episodes, "latest added" title
- Stream count, transcoding count, connection state, server uptime
- Triggers: new item added (filter by type / library, includes a poster
  image token for push notifications), library scan finished, user
  logged in (with user filter), transcoding started / stopped, stream
  count changed, connection lost / restored
- Actions: start library scan, restart server, shutdown server,
  health check

**User device** (one per Jellyfin user)
- Aggregates the user's currently active session — playback control
  automatically routes to whichever client the user is on right now
- Full transport control: play / pause, next / previous, volume (with
  cap), mute, seek, skip ±, skip chapter
- Now-playing: title, subtitle, position, duration, album art in the
  mobile app
- Standard capabilities: `speaker_track / artist / album` (compatible
  with Sonos-style flows)
- Custom capabilities: `client_online`, `is_transcoding`,
  `unwatched_count`, `continue_watching_title`, `watch_minutes_week`
- Triggers: started, paused, resumed, stopped, now-playing-changed,
  progress reached %, minutes before end, daily summary
- Actions: play item (autocomplete search), play random (with genre
  filter), continue watching, add to queue (next / last), clear queue,
  send message, set audio / subtitle track, mark watched, toggle
  favorite, bookmark

**Widgets**
- **Server overview**: user avatar initials, equalizer animation on
  active streams, count-up bump animation on stat changes, transcoding
  badges, automatic light / dark theme
- **Now playing**: big poster with blurred backdrop, scrubbable
  progress bar, full controls (prev chapter, −10 s, play / pause,
  +10 s, next chapter), ghost buttons for favorite & mark-watched

**Reliability**
- WebSocket + smart polling: idle = socket only, active = parallel fast
  polling, socket-down = slower HTTP fallback
- Auto-reconnect with exponential backoff
- Persistent "new item" cache (app restarts don't re-fire triggers)
- Stopped-trigger debounce against network blips
- HTTPS self-signed certificate support
- Repair flow: rotate the API key without losing the device or its
  flows

---

## Installing on a selfhosted Homey (no App Store)

Prerequisites: **Homey Pro** (local) or **Homey Core / Self-Hosted
Server** in Proxmox LXC / Docker / VM, reachable on your LAN.

### 1. Tools on your PC (Windows / macOS / Linux)

```powershell
# Node.js LTS (>=18)            https://nodejs.org
# Git                           https://git-scm.com/download/win
# Homey CLI                     global via npm
npm install -g homey
```

### 2. Sign in with Athom and pick your Homey

```powershell
homey login            # opens a browser, uses your developer.homey.app account
homey list             # shows reachable Homeys
homey select           # pick the right Homey interactively
```

If your selfhosted Homey doesn't broadcast over mDNS, set the IP
manually (PowerShell):

```powershell
$env:HOMEY_HOST = "192.168.1.48"   # IP of your LXC container
```

`homey whoami` confirms you're signed in and which Homey is active.

### 3. Clone the repo and check out the branch

```powershell
cd $HOME\Documents
git clone https://github.com/fbnlrz/homeyfin.git
cd homeyfin
git checkout claude/sharp-shannon-zmO4J   # or main once merged
npm install
```

### 4. Install the app

```powershell
homey app install
```

This is the **permanent install** — the app survives container reboots,
runs in the background, writes to the Homey system log.

`homey app install` internally:
1. Compiles TypeScript (output to `.homeybuild/`)
2. Validates the app (`level=debug` by default)
3. Packs it as a `.tar`
4. Deploys and installs it on the Homey

First install takes 30–60 s. Afterwards **"Homeyfin"** shows up in the
Homey app under *Settings → Apps*.

### 5. Configure in Homey

**Add the server device**
1. Homey app → *Devices → Add → Homeyfin → Jellyfin Server*
2. Enter the URL: `http://<jellyfin-ip>:8096`
3. Enter the API key (from Jellyfin: *Dashboard → API Keys → New API Key*)
4. Tap *Test connection* — the user dropdown appears
5. Pick the default user → *Add device*

**Add a user device per family member**
1. *Devices → Add → Homeyfin → Jellyfin User*
2. Pick the server from the dropdown, *Load users*
3. Pick the user, *Add user*

**Add widgets to the dashboard**
1. Open the dashboard → *Add widget*
2. Pick "Server overview" and/or "Now playing" from the gallery

---

## Updates

```powershell
cd $HOME\Documents\homeyfin
git pull
homey app install
```

The app ID and driver IDs stay the same → pairings, settings and flows
survive. Only the version should be bumped so Homey knows it's new:

`.homeycompose/app.json` → `"version": "0.1.0"` → `"0.2.0"` → save,
run `homey app install`.

---

## Reading logs

**During development (hot reload on changes):**
```powershell
npm run run
```

**Against an installed app (live log stream):**
```powershell
homey app log
```

**Inside the LXC itself** (SSH into the container):
```bash
journalctl -u homey-core -f | grep homeyfin
```

---

## Troubleshooting

**"Could not find a valid Homey App"**
→ The generated `app.json` is missing in the root. Fix:
`npm run build:manifest`, then `homey app install` again. The npm
scripts `validate` / `run` / `install:app` do this for you.

**"Expected outDir to be ./.homeybuild"**
→ tsconfig has the wrong `outDir`. Already fixed in the repo; on a
fork: set `outDir: "./.homeybuild"`.

**"api.js found but no api section in app.json manifest"**
→ A root-level `api.ts` without a matching `api` block. In this repo
widget APIs live under `widgets/<id>/api.ts` with their own `api` block
in `widget.compose.json` — no root-level API needed.

**Widget doesn't show up on the dashboard**
→ Make sure `widget.compose.json` sits directly in `widgets/<id>/`
(NOT under `.homeycompose/widgets/`). Plus `preview-light.png` +
`preview-dark.png` in the same folder.

**Compatibility error: "App widgets require >=12.1.0"**
→ Set `compatibility` in `.homeycompose/app.json` to `">=12.1.0"`.

**TLS error against an HTTPS Jellyfin with a self-signed cert**
→ Server device settings → *Allow self-signed HTTPS* → enable. Save
again (the hub restarts).

**Pair dialog closes on "Add" without an error**
→ Run `git pull` first. Older versions had a cross-view state issue
in the pair flow; the current branch (`claude/sharp-shannon-zmO4J`)
does everything in a single view.

**Push notification shows no cover image**
→ Use the `playback_started` trigger (it carries a `poster` image
token); in the notification action, map the image field to the token.

---

## Uninstall completely

```powershell
homey app uninstall com.frlrnzn.homeyfin
```

Removes the app, all devices and settings. Persisted entries
(`itemCache:`, `watch:`, `serverStartTs:`) are also cleaned up when
individual devices are deleted.

---

## Development / making changes

```bash
npm install
npm run build:manifest         # merges .homeycompose/ into app.json
npx tsc --noEmit               # type-check without emit
npm run validate               # build + homey app validate
npm run run                    # build + homey app run (hot-reload dev)
npm test                       # tsc -p tsconfig.test.json + unit tests
```

**Layers**
```
.homeycompose/         # manifest source (capabilities, flow, settings)
drivers/server/        # server driver + device
drivers/user/          # user driver + device
lib/JellyfinClient.ts  # REST wrapper (session, library, admin endpoints)
lib/JellyfinSocket.ts  # WebSocket with reconnect + keep-alive
lib/ServerHub.ts       # per-server singleton, event fan-out, smart polling
widgets/<id>/          # widget.compose.json + public/ + api.ts
scripts/build-app-json.mjs   # merges .homeycompose/ → app.json
scripts/build-assets.mjs     # generates PNG placeholders
app.ts                 # App.onInit/onUninit, hub pool
```

**Continuous integration** (`.github/workflows/ci.yml`)
- `tsc --noEmit`
- Unit tests (`node --import tsx --test test/*.test.ts`)
- Manifest build
- `homey app validate --level publish`

Runs on every push and PR.

---

## License

MIT — free to use, fork, modify. Jellyfin is a trademark of the
Jellyfin Foundation; this app is an unofficial third-party client and
is not affiliated with or endorsed by the Foundation.
