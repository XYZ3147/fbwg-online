// Loads the extension into every supported game and checks GitHub for updates.
importScripts('shared.js');

const { UPDATE_URL, DEFAULT_GAMES, cleanGames, cleanSettings, frameMatches, tabMatches, compareVersions } = FBWG;
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
    { id: 'fbwg-saves', js: ['shared.js', 'save-guard.js'], matches, allFrames: true, runAt: 'document_start' },
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
    settings: cleanSettings(data.settings),
    announcement: typeof data.announcement === 'string' ? data.announcement.slice(0, 300) : '',
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
  chrome.alarms.create('fbwg-disk', { periodInMinutes: 0.5 });
  checkQuietly();
});
chrome.runtime.onStartup.addListener(async () => {
  await setup();
  chrome.alarms.create('fbwg-disk', { periodInMinutes: 0.5 });
  checkQuietly();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'fbwg-update') checkQuietly();
  if (a.name === 'fbwg-disk') reloadIfUpdatedOnDisk().catch((e) => console.warn('[FBWG] disk check failed', e));
});

// ---------- picking up files replaced by Update.cmd ----------
// Chrome serves an unpacked extension's files straight from disk, so a newer
// manifest.json there means Update.cmd installed a new version. Reload to run
// it, but never in the middle of a game.
async function diskVersion() {
  const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
  return (await res.json()).version;
}

async function gameInProgress() {
  const viewers = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  if (viewers.some((c) => (c.documentUrl || '').includes('/viewer.html'))) return true;
  const tabs = await chrome.tabs.query({ url: tabMatches(await currentGames()) });
  for (const t of tabs) {
    try {
      const s = await chrome.tabs.sendMessage(t.id, { to: 'fbwg-host', type: 'status' });
      if (s && s.status !== 'idle') return true;
    } catch {}
  }
  return false;
}

async function reloadIfUpdatedOnDisk() {
  const self = await chrome.management.getSelf();
  if (self.installType !== 'development') return; // store installs update themselves
  const onDisk = await diskVersion();
  if (compareVersions(onDisk, chrome.runtime.getManifest().version) <= 0) return;
  if (await gameInProgress()) {
    await chrome.action.setBadgeText({ text: '↻' });
    await chrome.action.setBadgeBackgroundColor({ color: '#3db7ff' });
    return;
  }
  chrome.runtime.reload();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.to !== 'fbwg-bg') return;
  if (msg.type === 'diskCheck') {
    reloadIfUpdatedOnDisk().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type !== 'checkUpdates') return;
  checkForUpdates()
    .then((remote) => reply({ ok: true, remote }))
    .catch((e) => reply({ ok: false, error: e.message }));
  return true;
});
