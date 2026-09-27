// Shared between the host content script, the popup and the guest viewer.
var FBWG = (() => {
  const PEER_PREFIX = 'fbwg-online-';
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
  // Temple games (Flash engine) save as "/FB<Game>" in "AWAY…" format;
  // Elements saves under "fb-<game>…".
  const SAVE_KEY_PREFIXES = ['/FB', 'fb-'];
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
    iceServers: null, // null = PeerJS's own connection servers
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

  // "/FBForestTemple" -> "Forest Temple", "fb-elements:progress" -> "elements"
  function saveLabel(key) {
    const k = key.replace(/^\/FB|^fb-/, '').replace(/[:_].*$/, '');
    return k.replace(/([a-z])([A-Z])/g, '$1 $2') || key;
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
    UPDATE_URL, RELEASES_URL, SITE, DEFAULT_GAMES, cleanGames, frameMatches, tabMatches, compareVersions,
    isSaveKey, saveLabel, SAVE_HISTORY_MAX, DEFAULT_SETTINGS, cleanSettings, loadSettings, peerOptions,
  };
})();
