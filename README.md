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
1. Click the extension button, type the code under **Join a friend**, press **Join**.
2. Move with the arrow keys or W/A/D (either set controls your character). Click the
   picture to use the game's menus.
3. Click once on the picture for sound. `F` toggles fullscreen and `M` toggles mute.

## Saved progress

Each game saves your unlocked levels in the browser, shared between the normal game page and
the game-only window. Don't run two copies of the same game at once, because they can overwrite
each other's save. **Open game only** switches to an already open copy instead of opening a
second one.

## Updates

The extension checks GitHub every 6 hours. When a new version is out, the icon shows **NEW** and
the popup shows what changed, with a **Download update** button. You can also check any time
with **Check for updates** at the bottom of the popup.

Chrome doesn't let extensions install their own code, so updating takes three steps:
download, unzip over your folder, then click **Reload extension**. New games can be added without
a new version: they come through `update.json`, and the extension picks them up automatically.

### Publishing a new version (maintainer)

1. Bump `version` in `manifest.json`.
2. Update `update.json`: the same `version`, a few `notes`, and the `games` list if games were added.
3. Zip the folder contents as `fbwg-online.zip` and attach it to a new GitHub release.
4. Push `update.json` to `main`. Everyone's extension sees it within 6 hours, or right away
   when they click **Check for updates**.

To add a game only, edit the `games` list in `update.json` and push. Each entry needs
`id`, `name`, `page` (the Coolmath page path), `open` (the game-only path) and `frames`
(paths where the game itself runs, `*` allowed). Only coolmathgames.com paths are accepted.

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
| `shared.js` | Key maps, game list, room-code and version helpers. |
| `update.json` | Latest version, release notes and game list, read by the update checker. |
| `lib/peerjs.min.js` | [PeerJS](https://peerjs.com) 1.5.5 (MIT). |

## Limits

- One friend per room.
- Forest Temple draws at about 25 fps (its original Flash frame rate), so the stream runs at that rate too.
- The friend's picture is only as sharp as the host's game window is large.
- Some strict networks block direct connections. PeerJS then falls back to its public
  relay servers, which adds lag.
