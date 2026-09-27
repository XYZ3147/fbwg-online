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
3. Click **Copy invite link** and send it to your friend (or send the 5-letter room code).

While hosting, the game keeps running if you switch tabs or minimize, so your friend's
picture doesn't freeze.

**Friend**
1. Open the invite link and click **Join the game**, or click the extension button, type the code
   under **Join a friend** and press **Join**. The game opens in its own window, like the host's.
2. Move with your keys or controller (see **Controls** below). Click the picture to use the game's menus.
3. The top right shows frames per second, ping, the video buffer delay, and whether the connection is
   **direct** or **relayed** (relayed adds lag; it happens on strict networks).
4. Click once on the picture for sound. `F` toggles fullscreen and `M` toggles mute. The **Fit** button switches
   the picture between Fit (whole picture), Stretch (fills the window, a bit wider) and Zoom (fills it, edges cut off).

If the connection drops, the friend's window reconnects by itself (for up to a minute) and
drops straight back into the game. If the host's game tab reloads or crashes, it resumes hosting
with the **same room code**, so the friend gets back in the same way. When the host clicks
**Stop hosting**, the friend is told the game has ended instead.

**Signals:** press **1–4** to show *Wait!*, *Go!*, *Help!* or *Nice!* on both screens. To point at a
spot, the friend right-clicks the picture and the host Alt+clicks the game (the game doesn't see
that click). Signals are coloured by character.

**Picture quality:** the friend's **Smooth / Sharp** button. Smooth (default) sends up to 960 px
wide for the fewest hiccups; Sharp sends up to 1280 px at a higher bitrate, for fast connections.

## Controls

Open **Controls** from the popup or the friend's window. Settings apply whether you host or join,
and change right away, even mid-game.

- **Keyboard:** *Automatic* (Fireboy on arrow keys, Watergirl on WASD), *Arrow keys* or *WASD*, for
  either character. When you host, the other set of keys is ignored so you can't move your
  friend's character.
- **Controller:** works for both host and friend. Default buttons: D-pad or left stick to move,
  A / ✕ or D-pad ↑ to jump. To change a button, click **Add** next to an action and press the button
  or push the stick you want; **×** removes one. The matching action lights up while you press, so
  you can test it. **Stick sensitivity** sets how far the stick must be pushed.

## Two players on one computer

Open **Choose sides** from the popup (or the Controls page). It works like a sports game's side
select: Fireboy on the left, Watergirl on the right, "not playing" in the middle. Push a
controller's stick or D-pad left or right to move its card; the keyboard card has arrow buttons.
The screen lists every connected controller and which character it plays. Changes apply to an
open game right away.

- Two controllers: put one on each side.
- Keyboard + controller: put the keyboard on one character and the controller on the other. The
  keyboard then uses your chosen layout (Controls page) for its character and ignores the other keys.
- Keyboard in the middle ("Both") keeps the game's own keys: arrows for Fireboy, WASD for Watergirl.

When you host online, controllers on your character's side play your character (if none are, the
first controller does); the friend's character is always theirs.

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
| `settings.maxWidth` | The stream is scaled down to at most this width (320 to 3840, default 960). Smaller means less lag and bandwidth. |
| `settings.guestTimeoutMs` / `hostTimeoutMs` | How long a silent connection is kept before it's dropped (3,000 to 60,000 ms). |
| `settings.iceServers` | Replacement connection servers (`stun:`/`turn:` addresses), if PeerJS's own ones stop working. `null` uses PeerJS's. |
| `settings.savePrefixes` | Extra save-entry name prefixes to back up, for games that save under other names. |

Values outside the allowed ranges are ignored and the defaults are used.

## Supported games

| Game | Status |
| --- | --- |
| Forest Temple | Played end to end. |
| 2: Light Temple, 3: Ice Temple, 4: Crystal Temple | Same engine as Forest Temple. Checked: loads, streams at the game's ~25 fps, reads keys the same way, and saves under names the backup covers. |
| and Friends | Checked: loads on its own, streams (about 30 fps), reads keys the same way, and saves under names the backup covers. |
| 5: Elements | Reads keys the same way and saves under a covered name. It shows a video ad before the game, which couldn't be tested here. |

A full online session has only been played on Forest Temple so far.

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
| `controls.html/.js/.css` | Keyboard layout and controller buttons. |
| `players.html/.js/.css` | Side selection for playing on one computer. |
| `invite.js` | Runs on the invite page and asks the extension to open the game. |
| `docs/join/` | The invite page, served by GitHub Pages (not part of the extension zip). |
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
