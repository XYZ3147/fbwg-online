// Loads the extension into every supported game and checks GitHub for updates.
importScripts('shared.js');

const { UPDATE_URL, DEFAULT_GAMES, cleanGames, frameMatches, compareVersions } = FBWG;
const CHECK_EVERY_MINUTES = 6 * 60;

async function currentGames() {
  const { remote } = await chrome.storage.local.get('remote');
  return (remote && cleanGames(remote.games)) || DEFAULT_GAMES;
}

// The game list can change without a new version, so the scripts are
// registered at runtime from it instead of being fixed in the manifest.
async function registerScripts(games) {
  const matches = frameMatches(games);
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  await chrome.scripting.registerContentScripts([
    { id: 'fbwg-page-hook', js: ['page-hook.js'], matches, allFrames: true, runAt: 'document_start', world: 'MAIN' },
    { id: 'fbwg-host', js: ['lib/peerjs.min.js', 'shared.js', 'host.js'], matches, allFrames: true, runAt: 'document_idle' },
  ]);
}

async function setup() {
  try {
    await registerScripts(await currentGames());
  } catch (e) {
    console.warn('[FBWG] registering with the saved game list failed, using defaults', e);
    await registerScripts(DEFAULT_GAMES);
  }
}

async function showBadge(latest) {
  const newer = latest && compareVersions(latest, chrome.runtime.getManifest().version) > 0;
  await chrome.action.setBadgeText({ text: newer ? 'NEW' : '' });
  if (newer) await chrome.action.setBadgeBackgroundColor({ color: '#ff6a3d' });
}

async function checkForUpdates() {
  const res = await fetch(UPDATE_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Update server answered ${res.status}`);
  const data = await res.json();
  const remote = {
    version: typeof data.version === 'string' ? data.version : null,
    notes: Array.isArray(data.notes) ? data.notes.filter((n) => typeof n === 'string').slice(0, 10) : [],
    games: cleanGames(data.games),
  };
  const { remote: before } = await chrome.storage.local.get('remote');
  await chrome.storage.local.set({ remote, lastCheck: Date.now() });
  if (JSON.stringify(before && before.games) !== JSON.stringify(remote.games)) await setup();
  await showBadge(remote.version);
  return remote;
}

function checkQuietly() {
  checkForUpdates().catch((e) => console.warn('[FBWG] update check failed', e));
}

chrome.runtime.onInstalled.addListener(async () => {
  await setup();
  chrome.alarms.create('fbwg-update', { periodInMinutes: CHECK_EVERY_MINUTES });
  checkQuietly();
});
chrome.runtime.onStartup.addListener(async () => {
  await setup();
  checkQuietly();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'fbwg-update') checkQuietly(); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.to !== 'fbwg-bg' || msg.type !== 'checkUpdates') return;
  checkForUpdates()
    .then((remote) => reply({ ok: true, remote }))
    .catch((e) => reply({ ok: false, error: e.message }));
  return true;
});
