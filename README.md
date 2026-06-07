# Homeyfin

Selfhosted Jellyfin-Integration für Homey. SDK v3, TypeScript, ohne
App-Store-Veröffentlichung — du installierst direkt von Source auf dein
eigenes Homey.

PR: https://github.com/fbnlrz/homeyfin/pull/1

> **Built with Claude Code** — diese App wurde komplett *vibe-coded* mit
> [Claude Code](https://claude.com/claude-code) (Opus 4.7). Von Architektur
> über Implementierung, Bug-Audits und Pair-Flow-Debugging bis zum
> App-Store-Submit-Prep durch dialogische Iteration in einer einzigen
> Session entstanden. Die menschliche Hand am Steuer: Vision, Feedback
> nach jedem `homey app run --remote`, und die finalen Entscheidungen
> über Architektur und Scope.
>
> Du wirst sehen, dass Code-Style und Architektur konsequent durchgezogen
> sind — Resultat des kontinuierlichen Refactorings (Multi-Device-Flow-
> Listener-Bug, Pair-Cross-View-Race, Stop-Debounce, Smart-Polling).
> Bugs willkommen via Issues — die menschliche Reviewer-Schicht muss man
> für die Edge-Cases am Ende immer dazuhaben.

---

## Features auf einen Blick

**Server-Device** (1 pro Jellyfin-Instanz)
- Library-Counts: Filme, Serien, Folgen, „Zuletzt hinzugefügt"
- Stream-Count + Transcoding-Count, Connection-Status, Uptime
- Trigger: neuer Inhalt (mit Library/Typ-Filter, Poster-Image-Token),
  Library-Scan fertig, User logged-in (mit User-Filter),
  Transcoding-Start/Stop, Stream-Count-Änderung,
  Connection-Lost/Restored
- Actions: Library-Scan, Server-Restart, Server-Shutdown, Health-Check

**User-Device** (1 pro Jellyfin-User)
- Aggregiert die aktuell aktive Session des Users — Steuerung wirkt
  automatisch auf den Client wo der User gerade läuft
- Volle Wiedergabesteuerung: Play/Pause, Next/Prev, Volume (mit Cap),
  Mute, Seek, Skip ±, Skip-Chapter
- Now-Playing: Titel, Untertitel, Position, Dauer, Album-Art im
  Mobile-App
- Standard-Caps: `speaker_track/artist/album` (kompatibel mit Sonos &
  Co. Flows)
- Custom-Caps: `client_online`, `is_transcoding`, `unwatched_count`,
  `continue_watching_title`, `watch_minutes_week`
- Trigger: Started, Paused, Resumed, Stopped, Now-Playing-Changed,
  Progress reached %, Minutes before End, Daily Summary
- Actions: Play Item (Suche), Play Random (mit Genre-Filter),
  Continue Watching, Add to Queue (Next/Last), Clear Queue, Send
  Message, Set Audio/Subtitle Track, Mark Watched, Toggle Favorite,
  Bookmark

**Widgets**
- **Server overview**: User-Avatare mit Initialen, Equalizer-Animation
  bei aktiven Streams, Count-up-Bump bei Stat-Änderungen,
  Transcoding-Badges, Light/Dark-Mode automatisch
- **Now playing**: Großer Poster mit Backdrop-Blur, scrubbable
  Progress-Bar, volle Steuerung (Prev-Chapter, −10 s, Play/Pause,
  +10 s, Next-Chapter), Ghost-Buttons für Favorit & Watched

**Reliability**
- WebSocket + Smart-Polling: idle = nur Socket, active = paralleles
  schnelles Polling, Socket-Down = langsamer HTTP-Fallback
- Auto-Reconnect mit Backoff
- Persistenter „neue Inhalte"-Cache (App-Restart spammt keine Trigger)
- Stopped-Debounce gegen Netzwerk-Hiccups
- HTTPS-Self-Signed-Cert-Support
- Repair-Flow: API-Key ändern ohne Device + Flows zu verlieren

---

## Installation auf selfhosted Homey (ohne App-Store)

Vorausgesetzt: **Homey Pro** (lokal) oder **Homey Core / Self-Hosted
Server** in Proxmox-LXC/Docker/VM, erreichbar im LAN.

### 1. Tools auf deinem PC (Windows / macOS / Linux)

```powershell
# Node.js LTS (>=18)            https://nodejs.org
# Git                           https://git-scm.com/download/win
# Homey CLI                     global via npm
npm install -g homey
```

### 2. Mit Athom anmelden und deinen Homey auswählen

```powershell
homey login            # öffnet Browser, Account von developer.homey.app
homey list             # zeigt alle erreichbaren Homeys
homey select           # interaktiv den richtigen Homey wählen
```

Bei einem selfhosted Homey, der nicht via mDNS broadcastet, IP
manuell setzen (PowerShell):

```powershell
$env:HOMEY_HOST = "192.168.1.48"   # IP deines LXC-Containers
```

`homey whoami` bestätigt, dass du eingeloggt bist und welchen Homey du
hast.

### 3. Repo klonen und Branch auschecken

```powershell
cd $HOME\Documents
git clone https://github.com/fbnlrz/homeyfin.git
cd homeyfin
git checkout claude/sharp-shannon-zmO4J   # oder main wenn gemerged
npm install
```

### 4. App installieren

```powershell
homey app install
```

Das ist der **permanente Install** — die App überlebt Container-
Reboots, läuft im Hintergrund, schreibt Logs ins Homey-System-Log.

`homey app install` macht intern:
1. TypeScript kompilieren (Output nach `.homeybuild/`)
2. App validieren (`level=debug` per Default)
3. Als `.tar` packen
4. Auf den Homey deployen + installieren

Bei der ersten Installation kann das 30-60 s dauern. Danach erscheint
**„Homeyfin"** in der Homey-App unter *Einstellungen → Apps*.

### 5. In Homey einrichten

**Server-Device hinzufügen**
1. Homey-App → *Geräte → Hinzufügen → Homeyfin → Jellyfin Server*
2. URL eingeben: `http://<jellyfin-ip>:8096`
3. API-Key eingeben (aus Jellyfin: *Dashboard → API Keys → New API Key*)
4. *Test connection* klicken — User-Dropdown erscheint
5. Default-User wählen → *Add device*

**User-Devices hinzufügen** (eines pro Familienmitglied)
1. *Geräte → Hinzufügen → Homeyfin → Jellyfin User*
2. Server aus Dropdown wählen, *Load users* klicken
3. User auswählen, *Add user*

**Widgets aufs Dashboard**
1. Dashboard öffnen → *Widget hinzufügen*
2. „Server overview" und/oder „Now playing" aus der Galerie wählen

---

## Updates einspielen

```powershell
cd $HOME\Documents\homeyfin
git pull
homey app install
```

App-ID und Driver-IDs bleiben gleich → Pairings, Settings, Flows
bleiben erhalten. Nur die Version sollte hochgezählt werden, damit
Homey weiß, dass es neu ist:

`.homeycompose/app.json` → `"version": "0.1.0"` → `"0.2.0"` → speichern,
`homey app install` ausführen.

---

## Logs anschauen

**Während Entwicklung (Auto-Reload bei Änderungen):**
```powershell
npm run run
```

**Bei installierter App (nur Log-Stream):**
```powershell
homey app log
```

**Im LXC selbst** (SSH in den Container):
```bash
journalctl -u homey-core -f | grep homeyfin
```

---

## Troubleshooting

**„Could not find a valid Homey App"**
→ Generierte `app.json` fehlt im Root. Lösung: `npm run build:manifest`
ausführen, dann nochmal `homey app install`. Die npm-Scripts
`validate`/`run`/`install:app` machen das automatisch.

**„Expected outDir to be ./.homeybuild"**
→ tsconfig hat falschen `outDir`. Im Repo schon korrigiert; bei Fork:
`outDir: "./.homeybuild"` setzen.

**„api.js found but no api section in app.json manifest"**
→ App-Root-`api.ts` ohne korrespondierenden `api`-Block. Im Repo: Widget-
APIs liegen in `widgets/<id>/api.ts` mit eigenem `api`-Block im
`widget.compose.json` — kein Root-Level-API mehr nötig.

**Widget taucht nicht im Dashboard auf**
→ Sicherstellen, dass `widget.compose.json` direkt in `widgets/<id>/`
liegt (NICHT unter `.homeycompose/widgets/`). Plus
`preview-light.png` + `preview-dark.png` im selben Ordner.

**Compatibility-Error: „App widgets require >=12.1.0"**
→ `compatibility` in `.homeycompose/app.json` auf `">=12.1.0"` setzen.

**TLS-Fehler bei HTTPS-Jellyfin mit Self-Signed-Cert**
→ Server-Device-Settings → *Allow self-signed HTTPS* aktivieren. Dann
neu speichern (Hub startet neu).

**Pairing-Dialog schließt sich beim Klick auf Add ohne Fehler**
→ Vorher `git pull` machen. Frühere Versionen hatten ein
Cross-View-State-Problem im Pair-Flow; aktuelle Version (Branch
`claude/sharp-shannon-zmO4J`) macht alles in einem View.

**Push-Notification zeigt kein Cover**
→ `playback_started`-Trigger benutzen (hat einen `poster`-Image-Token);
in der Notification-Action das Bild-Feld auf den Token mappen.

---

## Komplette App entfernen

```powershell
homey app uninstall com.frlrnzn.homeyfin
```

Entfernt die App, alle Geräte und Settings. Persistierte Sachen
(`itemCache:`, `watch:`, `serverStartTs:`) werden auch beim Device-
Delete weggeräumt.

---

## Entwicklung / Eigene Änderungen

```bash
npm install
npm run build:manifest         # merges .homeycompose/ in app.json
npx tsc --noEmit               # type-check ohne Emit
npm run validate               # build + homey app validate
npm run run                    # build + homey app run (Hot-Reload-Dev)
npm test                       # tsc -p tsconfig.test.json + unit tests
```

**Schichten**
```
.homeycompose/         # Manifest-Quelle (capabilities, flow, settings)
drivers/server/        # Server-Driver + Device
drivers/user/          # User-Driver + Device
lib/JellyfinClient.ts  # REST-Wrapper (Session-, Library-, Admin-Endpoints)
lib/JellyfinSocket.ts  # WebSocket mit Reconnect + KeepAlive
lib/ServerHub.ts       # Singleton pro Server, Event-Fanout, Smart-Polling
widgets/<id>/          # widget.compose.json + public/ + api.ts
scripts/build-app-json.mjs   # merged .homeycompose/ → app.json
scripts/build-assets.mjs     # generiert PNG-Platzhalter
app.ts                 # App.onInit/onUninit, Hub-Pool
api.ts                 # (entfernt) — Widget-APIs liegen unter widgets/<id>/api.ts
```

**Continuous Integration** (`.github/workflows/ci.yml`)
- `tsc --noEmit`
- Unit-Tests (`node --import tsx --test test/*.test.ts`)
- Manifest-Build
- `homey app validate --level publish`

läuft auf jeden Push und PR.

---

## Lizenz

MIT — Frei nutzen, forken, modifizieren. Jellyfin ist Trademark der
Jellyfin-Project-Community; diese App ist ein inoffizielles Client-Tool.
