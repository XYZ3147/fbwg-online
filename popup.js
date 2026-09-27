(() => {
  const {
    ROLE_NAMES, normalizeCode, CODE_LENGTH, SITE, DEFAULT_GAMES, RELEASES_URL,
    cleanGames, tabMatches, compareVersions,
  } = FBWG;
  const VERSION = chrome.runtime.getManifest().version;
  const $ = (id) => document.getElementById(id);

  let games = DEFAULT_GAMES;
  let tabId = null; // tab running the host script we control
  let activeTabId = null;
  let last = null;
  let conflictTab = null;

  function selectedGame() {
    return games.find((g) => g.id === $('gameSelect').value) || games[0];
  }

  function fillGames() {
    const sel = $('gameSelect');
    let saved = null;
    try { saved = localStorage.getItem('fbwg-game'); } catch {}
    sel.textContent = '';
    for (const g of games) sel.add(new Option(g.name, g.id));
    if (saved && games.some((g) => g.id === saved)) sel.value = saved;
  }

  // A tab showing only the game (its own frame address), not the full site page.
  function isGameOnlyTab(tab, game) {
    const url = (tab.url || '').replace('https://coolmathgames.com', SITE);
    return game.frames.some((f) => url.startsWith(SITE + f.replace(/\*.*$/, '')));
  }

  async function askTab(id, type, extra = {}) {
    try {
      return await chrome.tabs.sendMessage(id, { to: 'fbwg-host', type, ...extra });
    } catch {
      return null; // no host script in this tab
    }
  }

  async function ask(type, extra) {
    return tabId == null ? null : askTab(tabId, type, extra);
  }

  async function gameTabs(list = games) {
    try {
      return await chrome.tabs.query({ url: tabMatches(list) });
    } catch {
      return [];
    }
  }

  // Prefer the tab the user is looking at; otherwise any open game tab, so the
  // controls also work for a game-only window (which has no toolbar button).
  async function findHostTab() {
    if (activeTabId != null) {
      const s = await askTab(activeTabId, 'status');
      if (s) return { id: activeTabId, state: s };
    }
    for (const t of await gameTabs()) {
      if (t.id === activeTabId) continue;
      const s = await askTab(t.id, 'status');
      if (s) return { id: t.id, state: s };
    }
    return null;
  }

  function render(s) {
    last = s;
    $('notOnGame').hidden = !!s;
    $('hostControls').hidden = !s;
    if (!s) return;

    const active = s.status !== 'idle';
    $('goToGameBtn').hidden = tabId === activeTabId;
    $('roleSelect').value = s.guestRole;
    $('hostKeys').textContent = s.hostRole
      ? `You play ${ROLE_NAMES[s.hostRole]} with ${s.hostKeys}`
      : '';
    $('startBtn').hidden = active;
    $('startBtn').disabled = !s.hasCanvas;
    $('startBtn').textContent = s.hasCanvas ? 'Start hosting' : 'Waiting for the game to load…';
    $('roomBox').hidden = !active;
    $('codeOut').textContent = s.code || '·····';
    $('copyBtn').disabled = !s.code || s.status === 'starting';
    $('inviteBtn').disabled = $('copyBtn').disabled;

    const st = $('hostStatus');
    st.className = 'status ' + (s.status === 'connected' ? 'connected' : s.status === 'error' ? 'error' : '');
    st.textContent = {
      starting: 'Creating room…',
      waiting: 'Waiting for your friend to join…',
      connected: `Friend connected as ${ROLE_NAMES[s.guestRole]}` + (s.rtt != null ? ` · ${Math.round(s.rtt)} ms` : ''),
      error: s.error,
    }[s.status] || '';
  }

  async function refresh() {
    if (tabId == null) {
      const found = await findHostTab();
      if (found) tabId = found.id;
      render(found ? found.state : null);
      return;
    }
    const s = await ask('status');
    if (!s) tabId = null; // tab closed or reloaded; look again next tick
    render(s);
  }

  async function focusTab(t) {
    await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(t.id, { active: true });
    window.close();
  }

  function openGameWindow() {
    chrome.windows.create({ url: SITE + selectedGame().open, type: 'popup', width: 960, height: 760, focused: true });
    window.close();
  }

  // Saved levels live in the site's local storage, shared by every tab of the
  // game. Two copies running at once can overwrite each other's save, so reuse
  // an open game instead of starting a second one.
  async function openGameOnly() {
    const game = selectedGame();
    const tabs = await gameTabs([game]);
    const onlyTab = tabs.find((t) => isGameOnlyTab(t, game));
    if (onlyTab) return focusTab(onlyTab);
    if (tabs.length) {
      conflictTab = tabs[0];
      $('conflictBox').hidden = false;
      return;
    }
    openGameWindow();
  }

  // ---------- updates ----------
  function showUpdate(remote) {
    const newer = remote && remote.version && compareVersions(remote.version, VERSION) > 0;
    $('updateCard').hidden = !newer;
    if (!newer) return false;
    $('updateVersion').textContent = 'Version ' + remote.version;
    $('currentVersion2').textContent = VERSION;
    const ul = $('updateNotes');
    ul.textContent = '';
    for (const n of remote.notes || []) {
      const li = document.createElement('li');
      li.textContent = n;
      ul.append(li);
    }
    ul.hidden = !ul.children.length;
    return true;
  }

  function applyRemote(remote) {
    const text = remote && typeof remote.announcement === 'string' ? remote.announcement : '';
    $('announcement').textContent = text;
    $('announcementCard').hidden = !text;
    const list = remote && cleanGames(remote.games);
    if (list) {
      games = list;
      fillGames();
    }
    return showUpdate(remote);
  }

  $('checkBtn').addEventListener('click', async () => {
    $('checkBtn').disabled = true;
    $('checkMsg').textContent = 'Checking…';
    let res;
    try {
      res = await chrome.runtime.sendMessage({ to: 'fbwg-bg', type: 'checkUpdates' });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    $('checkBtn').disabled = false;
    if (!res || !res.ok) {
      $('checkMsg').textContent = 'Could not check for updates: ' + ((res && res.error) || 'no answer');
      return;
    }
    $('checkMsg').textContent = applyRemote(res.remote) ? '' : `You have the latest version (${VERSION}).`;
  });
  $('downloadBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: RELEASES_URL + '/download/fbwg-online.zip' });
  });
  $('reloadExtBtn').addEventListener('click', () => chrome.runtime.reload());
  $('playersBtn').addEventListener('click', () => {
    chrome.windows.create({ url: chrome.runtime.getURL('players.html'), type: 'popup', width: 860, height: 720, focused: true });
    window.close();
  });
  $('savesBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('saves.html') });
    window.close();
  });

  async function showSaves() {
    const { saves } = await chrome.storage.local.get('saves');
    const cur = saves && saves.current;
    if (!cur) return;
    const mins = Math.round((Date.now() - cur.updated) / 60000);
    const age = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
    const n = Object.keys(cur.items).length;
    $('savesInfo').textContent = `Saved progress: ${n} game${n > 1 ? 's' : ''} backed up ${age}`;
  }
  $('gameSelect').addEventListener('change', (e) => {
    $('conflictBox').hidden = true;
    try { localStorage.setItem('fbwg-game', e.target.value); } catch {}
  });

  $('openGameBtn').addEventListener('click', openGameOnly);
  $('conflictGoBtn').addEventListener('click', () => conflictTab && focusTab(conflictTab));
  $('conflictSwitchBtn').addEventListener('click', async () => {
    if (conflictTab) {
      try { await chrome.tabs.remove(conflictTab.id); } catch {}
    }
    openGameWindow();
  });
  $('goToGameBtn').addEventListener('click', async () => {
    try { focusTab(await chrome.tabs.get(tabId)); } catch {}
  });

  $('startBtn').addEventListener('click', async () => {
    render(await ask('start', { guestRole: $('roleSelect').value }));
  });
  $('stopBtn').addEventListener('click', async () => render(await ask('stop')));
  $('roleSelect').addEventListener('change', async (e) => render(await ask('role', { role: e.target.value })));
  for (const b of document.querySelectorAll('.controls-link')) {
    b.addEventListener('click', () => {
      chrome.windows.create({ url: chrome.runtime.getURL('controls.html'), type: 'popup', width: 560, height: 760, focused: true });
      window.close();
    });
  }

  $('inviteBtn').addEventListener('click', async () => {
    if (!last || !last.code) return;
    try {
      await navigator.clipboard.writeText(FBWG.inviteLink(last.code));
      $('inviteBtn').textContent = 'Link copied. Send it to your friend';
      setTimeout(() => { $('inviteBtn').textContent = 'Copy invite link'; }, 2000);
    } catch {}
  });

  $('copyBtn').addEventListener('click', async () => {
    if (!last || !last.code) return;
    try {
      await navigator.clipboard.writeText(last.code);
      $('copyBtn').textContent = 'Copied';
      setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1200);
    } catch {}
  });

  $('joinCode').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('joinCode').value);
    if (code.length !== CODE_LENGTH) {
      $('joinCode').focus();
      return;
    }
    // Same kind of window as the host's game-only window.
    chrome.windows.create({
      url: chrome.runtime.getURL('viewer.html?code=' + code),
      type: 'popup', width: 960, height: 800, focused: true,
    });
    window.close();
  });

  (async () => {
    $('currentVersion').textContent = VERSION;
    // Pick up a version that Update.cmd just installed.
    chrome.runtime.sendMessage({ to: 'fbwg-bg', type: 'diskCheck' }).catch(() => {});
    fillGames();
    showSaves();
    const { remote } = await chrome.storage.local.get('remote');
    applyRemote(remote);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab ? tab.id : null;
    const openGames = await gameTabs();
    if (openGames.length) {
      $('notOnGameText').textContent =
        'The game is open but the extension can\'t reach it, usually because the extension was reloaded after the game opened. Finish your level, then reload the game tab.';
    }
    await refresh();
    setInterval(refresh, 1000);
  })();
})();
