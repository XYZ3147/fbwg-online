# Fireboy & Watergirl Online

A Chrome extension that lets two people on **different computers** play Fireboy and
Watergirl on Coolmath Games together. Made by XYZ.

The host runs the game. The extension streams the game's picture and sound to the
friend and replays the friend's keys and clicks into the host's game. The two computers
connect directly (WebRTC, with the free PeerJS server for the initial handshake), so no
account or server setup is needed.

## Install (both players)

1. Download `fbwg-online.zip` from the
   [latest release](https://github.com/XYZ3147/fbwg-online/releases/latest) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder.
4. Pin the extension (puzzle-piece icon → pin).

## Play

**Host**
1. Click the extension button, pick a game, and click **Open game only**. The game opens in
   its own window without the rest of the website. The normal Coolmath page works too.
2. Click the extension button → choose which character your friend plays → **Start hosting**.
3. Send your friend the 5-letter room code.

While hosting, the game keeps running if you switch tabs or minimize, so your friend's
picture doesn't freeze.

**Friend**
1. Click the extension button, type the code under **Join a friend**, press **Join**. The game
   opens in its own window, like the host's.
2. Move with the arrow keys or W/A/D (either set controls your character). Click the
   picture to use the game's menus.
3. Click once on the picture for sound. `F` toggles fullscreen and `M` toggles mute.

## Saved progress

Each game saves your unlocked levels in the browser, shared between the normal game page and
the game-only window. Don't run two copies of the same game at once, because they can overwrite
each other's save. **Open game only** switches to an already open copy instead of opening a
second one.

### Backups

The extension also keeps its own copy of each game's save, separate from the website's storage.
It copies the save about every 15 seconds while a game is open, and when you close it. The latest copy is kept,
plus up to 10 older versions at least 10 minutes apart. If the website's copy disappears (for example
after clearing site data), it's put back the next time the game opens. **Manage** in the popup lets you export saves to
a file, import them (also on another computer), or go back to an older version. Only the games'
save entries are copied, not the site's ad or tracking data.

## Updates

The extension checks GitHub every 6 hours. When a new version is out, the icon shows **NEW**
and the popup shows what changed. You can also check any time with **Check for updates** at
the bottom of the popup.

**To update:** open your extension folder (the one you picked with *Load unpacked*) and
double-click **Update.cmd**. It downloads the latest version from GitHub, checks that it's
really this extension, and replaces the files. The extension notices the new files and restarts
itself within about 30 seconds. If you're hosting or in a game, it waits and shows a blue ↻ on
the icon until the game ends. Windows may ask for confirmation the first time you run Update.cmd.

Chrome doesn't let extensions install their own code, which is why this one step is needed. Many
changes don't need it at all: new games, save formats, connection settings and popup messages
come through `update.json` and reach everyone automatically.

### Publishing a new version (maintainer)

1. Bump `version` in `manifest.json`.
2. Update `update.json`: the same `version`, a few `notes`, and anything else below that changed.
3. Commit, then build the zip with `git archive --format=zip -o ../fbwg-online.zip HEAD` and
   attach it as `fbwg-online.zip` to a new GitHub release (tag `vX.Y.Z`).
4. Push to `main`. Everyone's extension sees it within 6 hours, or right away with **Check for updates**.

### Changing things without a new version

Edit `update.json` on `main` and push; no release needed.

| Field | What it does |
| --- | --- |
| `games` | The game list. Each entry: `id`, `name`, `page` (Coolmath page path), `open` (game-only path), `frames` (paths where the game runs, `*` allowed). Only coolmathgames.com paths are accepted. |
| `announcement` | A short message shown at the top of the popup (up to 300 characters). Empty hides it. |
| `settings.maxBitrate` | Video quality cap in bits per second (250,000 to 20,000,000). |
| `settings.maxFramerate` | Stream frame rate cap (10 to 120). |
| `settings.guestTimeoutMs` / `hostTimeoutMs` | How long a silent connection is kept before it's dropped (3,000 to 60,000 ms). |
| `settings.iceServers` | Replacement connection servers (`stun:`/`turn:` addresses), if PeerJS's own ones stop working. `null` uses PeerJS's. |
| `settings.savePrefixes` | Extra save-entry name prefixes to back up, for games that save under other names. |

Values outside the allowed ranges are ignored and the defaults are used.

## Supported games

Forest Temple (tested end to end), 2: Light Temple, 3: Ice Temple, 4: Crystal Temple
(same engine as Forest Temple), 5: Elements (checked: it accepts the injected keys), and
Fireboy and Watergirl and Friends.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest. |
| `background.js` | Loads the scripts into the supported games and checks for updates. |
| `page-hook.js` | Runs in the page's own JS world before the game: injects keys, blocks the host's keys for the friend's character, taps Web Audio, and keeps the game running in hidden tabs while hosting. |
| `host.js` | Host side: room code, WebRTC stream of the game canvas and sound, replay of the friend's input. |
| `viewer.html/.js/.css` | Friend side: joins by code, shows the stream, sends keys and clicks. |
| `popup.html/.js/.css` | Game picker, host controls, join box, update check. |
| `save-guard.js` | Backs up each game's save to extension storage and restores it if missing. |
| `saves.html/.js/.css` | Manage saves: export, import, older versions, delete. |
| `Update.cmd`, `update.ps1` | One-click updater: downloads the latest release and replaces the files. |
| `shared.js` | Key maps, game list, room-code and version helpers. |
| `update.json` | Latest version, release notes and game list, read by the update checker. |
| `lib/peerjs.min.js` | [PeerJS](https://peerjs.com) 1.5.5 (MIT). |

## Limits

- One friend per room.
- Forest Temple draws at about 25 fps (its original Flash frame rate), so the stream runs at that rate too.
- The friend's picture is only as sharp as the host's game window is large.
- Some strict networks block direct connections. PeerJS then falls back to its public
  relay servers, which adds lag.
