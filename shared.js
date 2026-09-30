// Shared between the host content script, the popup and the guest viewer.
var FBWG = (() => {
  const PEER_PREFIX = 'fbwg-online-';
  // Bumped when host and friend must both update to keep working together.
  // 2: video, sound and fast keys share the one connection.
  const PROTO = 2;
  const FAST_LABEL = 'fbwg-fast';
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LENGTH = 5;

  // The keys the game itself reads for each character.
  const ROLE_KEYS = {
    fireboy: {
      up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    },
    watergirl: {
      up: { key: 'w', code: 'KeyW', keyCode: 87 },
      left: { key: 'a', code: 'KeyA', keyCode: 65 },
      right: { key: 'd', code: 'KeyD', keyCode: 68 },
      down: { key: 's', code: 'KeyS', keyCode: 83 },
    },
  };

  const ROLE_NAMES = { fireboy: 'Fireboy', watergirl: 'Watergirl' };
  const DIRECTIONS = ['up', 'left', 'right', 'down'];

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  function normalizeCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function peerIdFor(code) {
    return PEER_PREFIX + normalizeCode(code).toLowerCase();
  }

  function otherRole(role) {
    return role === 'fireboy' ? 'watergirl' : 'fireboy';
  }

  // ---------- controls ----------
  // Which physical keys a player moves with. "auto" = the character's usual
  // keys (Fireboy arrows, Watergirl WASD); the player can pick either set for
  // either character.
  const LAYOUT_KEYS = { arrows: ROLE_KEYS.fireboy, wasd: ROLE_KEYS.watergirl };
  const LAYOUT_NAMES = { auto: 'Automatic', arrows: 'Arrow keys', wasd: 'WASD' };
  function layoutFor(role, keyboard) {
    if (keyboard === 'arrows' || keyboard === 'wasd') return keyboard;
    return role === 'fireboy' ? 'arrows' : 'wasd';
  }

  // Controller bindings: a button, or a stick axis pushed past the dead zone.
  const DEFAULT_BINDINGS = {
    up: [{ type: 'button', index: 0 }, { type: 'button', index: 12 }],
    left: [{ type: 'button', index: 14 }, { type: 'axis', index: 0, dir: -1 }],
    right: [{ type: 'button', index: 15 }, { type: 'axis', index: 0, dir: 1 }],
    down: [{ type: 'button', index: 13 }, { type: 'axis', index: 1, dir: 1 }],
  };
  const DEFAULT_CONTROLS = { keyboard: 'auto', gamepad: { enabled: true, deadzone: 0.5, bindings: DEFAULT_BINDINGS } };
  const ACTION_NAMES = { up: 'Jump', left: 'Move left', right: 'Move right', down: 'Down' };

  function cleanBinding(b) {
    if (!b || typeof b !== 'object' || !Number.isInteger(b.index) || b.index < 0 || b.index > 31) return null;
    if (b.type === 'button') return { type: 'button', index: b.index };
    if (b.type === 'axis' && (b.dir === 1 || b.dir === -1)) return { type: 'axis', index: b.index, dir: b.dir };
    return null;
  }

  function cleanControls(raw) {
    const c = JSON.parse(JSON.stringify(DEFAULT_CONTROLS));
    if (!raw || typeof raw !== 'object') return c;
    if (['auto', 'arrows', 'wasd'].includes(raw.keyboard)) c.keyboard = raw.keyboard;
    const g = raw.gamepad;
    if (g && typeof g === 'object') {
      if (typeof g.enabled === 'boolean') c.gamepad.enabled = g.enabled;
      if (typeof g.deadzone === 'number' && g.deadzone >= 0.1 && g.deadzone <= 0.9) c.gamepad.deadzone = g.deadzone;
      if (g.bindings && typeof g.bindings === 'object') {
        for (const dir of DIRECTIONS) {
          if (Array.isArray(g.bindings[dir])) c.gamepad.bindings[dir] = g.bindings[dir].map(cleanBinding).filter(Boolean).slice(0, 4);
        }
      }
    }
    return c;
  }

  async function loadControls() {
    try {
      const { controls } = await chrome.storage.local.get('controls');
      return cleanControls(controls);
    } catch {
      return cleanControls(null);
    }
  }

  // Which actions a controller is pressing right now.
  function readPad(pad, gamepad) {
    const out = {};
    if (!pad) return out;
    for (const dir of DIRECTIONS) {
      out[dir] = (gamepad.bindings[dir] || []).some((b) => {
        if (b.type === 'button') return !!(pad.buttons[b.index] && pad.buttons[b.index].pressed);
        const v = pad.axes[b.index];
        return typeof v === 'number' && v * b.dir > gamepad.deadzone;
      });
    }
    return out;
  }

  // First connected controller's actions, or {} when none (or disabled).
  function readGamepads(gamepad) {
    if (!gamepad.enabled || !navigator.getGamepads) return {};
    for (const pad of navigator.getGamepads()) if (pad && pad.connected) return readPad(pad, gamepad);
    return {};
  }

  const BUTTON_NAMES = ['A / ✕', 'B / ○', 'X / □', 'Y / △', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2',
    'Back / Share', 'Start / Options', 'Left stick press', 'Right stick press',
    'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home'];
  function bindingLabel(b) {
    if (b.type === 'button') return BUTTON_NAMES[b.index] || `Button ${b.index}`;
    const stick = b.index < 2 ? 'Left stick' : b.index < 4 ? 'Right stick' : `Axis ${b.index}`;
    const horizontal = b.index % 2 === 0;
    const arrow = horizontal ? (b.dir < 0 ? '←' : '→') : (b.dir < 0 ? '↑' : '↓');
    return `${stick} ${arrow}`;
  }

  // ---------- players (side selection for local play) ----------
  // keyboard: 'fireboy' | 'both' | 'watergirl'; pads: { padKey: 'fireboy' | 'none' | 'watergirl' }
  const DEFAULT_PLAYERS = { keyboard: 'both', pads: {} };

  // Two identical controllers report the same name, so the slot number is part of the key.
  function padKey(pad) {
    return `${pad.index}|${pad.id}`;
  }

  function padName(pad) {
    const name = String(pad.id || '').replace(/\s*\(.*$/, '').trim();
    return name || 'Controller';
  }

  function cleanPlayers(raw) {
    const p = { keyboard: DEFAULT_PLAYERS.keyboard, pads: {} };
    if (!raw || typeof raw !== 'object') return p;
    if (['fireboy', 'both', 'watergirl'].includes(raw.keyboard)) p.keyboard = raw.keyboard;
    if (raw.pads && typeof raw.pads === 'object') {
      for (const [k, v] of Object.entries(raw.pads).slice(0, 16)) {
        if (typeof k === 'string' && k.length < 200 && ['fireboy', 'none', 'watergirl'].includes(v)) p.pads[k] = v;
      }
    }
    return p;
  }

  async function loadPlayers() {
    try {
      const { players } = await chrome.storage.local.get('players');
      return cleanPlayers(players);
    } catch {
      return cleanPlayers(null);
    }
  }

  // ---------- quick signals (drawn on both screens) ----------
  const SIGNAL_TEXTS = ['Wait!', 'Go!', 'Help!', 'Nice!'];
  const SIGNAL_COLORS = { fireboy: '#ff6a3d', watergirl: '#3db7ff' };

  function injectSignalStyles(doc) {
    if (doc.getElementById('fbwg-signal-styles')) return;
    const st = doc.createElement('style');
    st.id = 'fbwg-signal-styles';
    st.textContent = `
      .fbwg-bubble { position: absolute; top: 6%; left: 50%; transform: translate(-50%, 0);
        font: 800 clamp(16px, 4vw, 34px)/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
        padding: .35em .8em; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.45);
        animation: fbwg-pop 2.6s ease forwards; white-space: nowrap; }
      .fbwg-mark { position: absolute; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
        border: 4px solid currentColor; box-shadow: 0 0 0 3px rgba(0,0,0,.4); animation: fbwg-ping 3s ease-out forwards; }
      .fbwg-mark::after { content: ''; position: absolute; left: 50%; top: 50%; width: 10px; height: 10px;
        margin: -5px 0 0 -5px; border-radius: 50%; background: currentColor; }
      @keyframes fbwg-pop { 0% { opacity: 0; transform: translate(-50%, -10px) scale(.8); }
        10% { opacity: 1; transform: translate(-50%, 0) scale(1); } 80% { opacity: 1; } 100% { opacity: 0; } }
      @keyframes fbwg-ping { 0% { transform: scale(.4); opacity: 1; } 20% { transform: scale(1); }
        40% { transform: scale(.8); } 60% { transform: scale(1); } 100% { transform: scale(1); opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { .fbwg-bubble, .fbwg-mark { animation-duration: 2.6s; animation-name: none; } }`;
    (doc.head || doc.documentElement).appendChild(st);
  }

  // Draw one signal inside `layer` (a box covering the game picture).
  function renderSignal(layer, sig, from) {
    const color = SIGNAL_COLORS[from] || '#fff';
    const el = layer.ownerDocument.createElement('div');
    if (sig && sig.kind === 'msg' && SIGNAL_TEXTS[sig.i]) {
      el.className = 'fbwg-bubble';
      el.textContent = SIGNAL_TEXTS[sig.i];
      el.style.background = color;
    } else if (sig && sig.kind === 'mark' && Number.isFinite(+sig.x) && Number.isFinite(+sig.y)) {
      el.className = 'fbwg-mark';
      el.style.color = color;
      el.style.left = Math.min(1, Math.max(0, +sig.x)) * 100 + '%';
      el.style.top = Math.min(1, Math.max(0, +sig.y)) * 100 + '%';
    } else {
      return;
    }
    layer.appendChild(el);
    setTimeout(() => el.remove(), 3100);
  }

  // Invite links open this page; the extension's content script there opens the game.
  const JOIN_PAGE = 'https://xyz3147.github.io/fbwg-online/join/';
  function inviteLink(code) {
    return JOIN_PAGE + '#' + normalizeCode(code);
  }

  // Where new versions and new games are announced. The file holds data only
  // (version, notes, game addresses); Chrome does not allow extensions to
  // download code, so new code arrives as a new zip the user installs.
  const UPDATE_URL = 'https://raw.githubusercontent.com/XYZ3147/fbwg-online/main/update.json';
  const RELEASES_URL = 'https://github.com/XYZ3147/fbwg-online/releases/latest';

  const SITE = 'https://www.coolmathgames.com';
  // `open` is the game-only address; `frames` are where the game itself runs,
  // which is where the extension loads. The update file can replace this list.
  const DEFAULT_GAMES = [
    { id: 'forest', name: 'Forest Temple', page: '/0-fireboy-and-water-girl-in-the-forest-temple',
      open: '/0-fireboy-and-water-girl-in-the-forest-temple/play', frames: ['/0-fireboy-and-water-girl-in-the-forest-temple/play*'] },
    { id: 'light', name: '2: Light Temple', page: '/0-fireboy-watergirl-2-light-temple',
      open: '/0-fireboy-watergirl-2-light-temple/play', frames: ['/0-fireboy-watergirl-2-light-temple/play*'] },
    { id: 'ice', name: '3: Ice Temple', page: '/0-fireboy-watergirl-3-ice-temple',
      open: '/0-fireboy-watergirl-3-ice-temple/play', frames: ['/0-fireboy-watergirl-3-ice-temple/play*'] },
    { id: 'crystal', name: '4: Crystal Temple', page: '/0-fireboy-watergirl-4-crystal-temple',
      open: '/0-fireboy-watergirl-4-crystal-temple/play', frames: ['/0-fireboy-watergirl-4-crystal-temple/play*'] },
    { id: 'elements', name: '5: Elements', page: '/0-fireboy-watergirl-5-elements',
      open: '/sites/default/files/public_games/40218/', frames: ['/sites/default/files/public_games/40218/*'] },
    { id: 'friends', name: 'and Friends', page: '/0-fireboy-and-watergirl-and-friends',
      open: '/sites/default/files/public_games/56292/', frames: ['/sites/default/files/public_games/56292/*'] },
  ];

  const SAFE_PATH = /^\/[A-Za-z0-9_\-./*]*$/;

  // Keep only well-formed entries on coolmathgames.com, so a bad update file
  // can't point the extension anywhere else.
  function cleanGames(list) {
    if (!Array.isArray(list)) return null;
    const out = list.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string'
      && typeof g.page === 'string' && SAFE_PATH.test(g.page)
      && typeof g.open === 'string' && SAFE_PATH.test(g.open) && !g.open.includes('*')
      && Array.isArray(g.frames) && g.frames.length && g.frames.every((f) => typeof f === 'string' && SAFE_PATH.test(f)))
      .map((g) => ({ id: g.id, name: g.name.slice(0, 60), page: g.page, open: g.open, frames: g.frames }));
    return out.length ? out : null;
  }

  // Match patterns for where the extension should load (both site hostnames).
  function frameMatches(games) {
    const set = new Set();
    for (const g of games) for (const f of g.frames) {
      set.add(SITE + f);
      set.add('https://coolmathgames.com' + f);
    }
    return [...set];
  }

  // Match patterns for any open tab of these games (page or game-only).
  function tabMatches(games) {
    const set = new Set(frameMatches(games));
    for (const g of games) {
      set.add(SITE + g.page + '*');
      set.add('https://coolmathgames.com' + g.page + '*');
    }
    return [...set];
  }

  // Which site storage entries are game saves (the rest is ads and trackers).
  // Temple games (Flash engine) save as "/FB<Name>" in "AWAY…" format
  // (/FBForestTemple, /FBCookie, /FBAWG3, /FBAWG4); Elements and Friends save
  // under "fb-<game>:progress", and Friends keeps owned items in "localStore".
  const SAVE_KEY_PREFIXES = ['/FB', 'fb-', 'localStore'];
  const SAVE_HISTORY_MAX = 10;
  function isSaveKey(key, value, extraPrefixes = []) {
    if (typeof key !== 'string') return false;
    if (SAVE_KEY_PREFIXES.some((p) => key.startsWith(p))) return true;
    if (extraPrefixes.some((p) => key.startsWith(p))) return true;
    return typeof value === 'string' && value.startsWith('AWAY');
  }

  // Settings the update file can change without a new version. Anything
  // missing or out of range falls back to these defaults.
  const DEFAULT_SETTINGS = {
    maxBitrate: 4000000, // video quality cap, bits per second
    maxFramerate: 60,
    maxWidth: 960, // stream is scaled down to at most this width (the games are ~640 px)
    guestTimeoutMs: 8000, // host frees the slot after this much silence
    hostTimeoutMs: 10000, // friend gives up after this much silence
    // Address servers (STUN) help the two computers find a direct route. There
    // is no relay (TURN) by default: PeerJS's free relay hosts stopped resolving
    // (checked 2026-09-30), so strict networks need one added here or through
    // update.json, e.g. { urls: 'turn:host:3478', username: '…', credential: '…' }.
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
    savePrefixes: [], // extra save-entry name prefixes to back up
  };

  function num(v, min, max, fallback) {
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  }

  function cleanSettings(raw) {
    const s = { ...DEFAULT_SETTINGS };
    if (!raw || typeof raw !== 'object') return s;
    s.maxBitrate = num(raw.maxBitrate, 250000, 20000000, s.maxBitrate);
    s.maxFramerate = num(raw.maxFramerate, 10, 120, s.maxFramerate);
    s.maxWidth = num(raw.maxWidth, 320, 3840, s.maxWidth);
    s.guestTimeoutMs = num(raw.guestTimeoutMs, 3000, 60000, s.guestTimeoutMs);
    s.hostTimeoutMs = num(raw.hostTimeoutMs, 3000, 60000, s.hostTimeoutMs);
    if (Array.isArray(raw.iceServers)) {
      const servers = raw.iceServers.filter((x) => x && typeof x === 'object'
        && [].concat(x.urls).every((u) => typeof u === 'string' && /^(stun|turns?):/.test(u)))
        .slice(0, 8)
        .map((x) => {
          const o = { urls: x.urls };
          if (typeof x.username === 'string') o.username = x.username;
          if (typeof x.credential === 'string') o.credential = x.credential;
          return o;
        });
      if (servers.length) s.iceServers = servers;
    }
    if (Array.isArray(raw.savePrefixes)) {
      s.savePrefixes = raw.savePrefixes.filter((p) => typeof p === 'string' && p.length >= 2 && p.length <= 40).slice(0, 20);
    }
    return s;
  }

  function peerOptions(settings) {
    const o = { debug: 1 };
    if (settings && settings.iceServers) o.config = { iceServers: settings.iceServers };
    return o;
  }

  // For extension pages and content scripts: the settings from the last update check.
  async function loadSettings() {
    try {
      const { remote } = await chrome.storage.local.get('remote');
      return cleanSettings(remote && remote.settings);
    } catch {
      return cleanSettings(null);
    }
  }

  // Readable names for the Manage saves page; unknown keys show as-is.
  const SAVE_LABELS = {
    '/FBForestTemple': 'Forest Temple',
    '/FBAWG3': 'Ice Temple',
    '/FBAWG4': 'Crystal Temple',
    '/FBCookie': 'Temple games (shared)',
    'localStore': 'and Friends: owned items',
  };
  function saveLabel(key) {
    if (SAVE_LABELS[key]) return SAVE_LABELS[key];
    const m = key.match(/^fb-([^:]+):(.+)$/);
    if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)}: ${m[2]}`;
    return key.replace(/^\//, '');
  }

  function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  return {
    ROLE_KEYS, ROLE_NAMES, DIRECTIONS, CODE_LENGTH, newCode, normalizeCode, peerIdFor, otherRole,
    PROTO, FAST_LABEL,
    UPDATE_URL, RELEASES_URL, SITE, DEFAULT_GAMES, cleanGames, frameMatches, tabMatches, compareVersions,
    isSaveKey, saveLabel, SAVE_HISTORY_MAX, DEFAULT_SETTINGS, cleanSettings, loadSettings, peerOptions,
    LAYOUT_KEYS, LAYOUT_NAMES, layoutFor, DEFAULT_CONTROLS, ACTION_NAMES, cleanControls, loadControls,
    readPad, readGamepads, bindingLabel, cleanBinding, JOIN_PAGE, inviteLink,
    DEFAULT_PLAYERS, padKey, padName, cleanPlayers, loadPlayers,
    SIGNAL_TEXTS, SIGNAL_COLORS, injectSignalStyles, renderSignal,
  };
})();
