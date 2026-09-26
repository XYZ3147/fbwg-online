(() => {
  const { isSaveKey, saveLabel } = FBWG;
  const $ = (id) => document.getElementById(id);
  const FORMAT = 'fbwg-online-saves';
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

  let saves = null;

  function when(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
    return `${new Date(ts).toLocaleString()} (${rel})`;
  }

  function labels(items) {
    return Object.keys(items || {}).map(saveLabel);
  }

  function say(text, ok = false) {
    $('msg').textContent = text;
    $('msg').classList.toggle('ok', ok);
  }

  async function load() {
    const data = await chrome.storage.local.get(['saves', 'autoRestore', 'pendingRestore']);
    saves = data.saves || null;
    $('autoRestore').checked = data.autoRestore !== false;

    const cur = saves && saves.current;
    $('latestInfo').textContent = cur
      ? `Last saved ${when(cur.updated)}.`
      : 'No backup yet. Open a Fireboy and Watergirl game and finish a level.';
    const ul = $('latestGames');
    ul.textContent = '';
    for (const l of cur ? labels(cur.items) : []) {
      const li = document.createElement('li');
      li.textContent = l;
      ul.append(li);
    }
    $('exportBtn').disabled = !cur;

    const ol = $('history');
    ol.textContent = '';
    const hist = (saves && saves.history) || [];
    $('noHistory').hidden = hist.length > 0;
    hist.forEach((h) => {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = ` · ${labels(h.items).join(', ')}`;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Restore this';
      b.addEventListener('click', () => queueRestore(h.items, `the version from ${new Date(h.updated).toLocaleString()}`));
      li.append(document.createTextNode(new Date(h.updated).toLocaleString()), what, b);
      ol.append(li);
    });

    if (data.pendingRestore) say('A restore is waiting. Open (or reload) a Fireboy and Watergirl game to apply it.', true);
  }

  async function queueRestore(items, what) {
    if (!confirm(`Restore ${what}?\n\nThe saves for ${labels(items).join(', ')} will be replaced the next time a game opens. Close other game tabs first.`)) return;
    await chrome.storage.local.set({ pendingRestore: { items, queued: Date.now() } });
    say('Restore ready. Open (or reload) a Fireboy and Watergirl game to apply it.', true);
  }

  $('autoRestore').addEventListener('change', (e) => chrome.storage.local.set({ autoRestore: e.target.checked }));

  $('exportBtn').addEventListener('click', () => {
    if (!saves || !saves.current) return;
    const file = { format: FORMAT, version: 1, exported: Date.now(), items: saves.current.items };
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `fireboy-watergirl-saves-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say('Exported. Keep the file somewhere safe; you can import it on any computer.', true);
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > MAX_IMPORT_BYTES) throw new Error('That file is too big to be a save file.');
      const data = JSON.parse(await f.text());
      if (!data || data.format !== FORMAT || typeof data.items !== 'object' || !data.items) throw new Error('That isn\'t a Fireboy & Watergirl Online save file.');
      const items = {};
      for (const [k, v] of Object.entries(data.items)) if (typeof v === 'string' && isSaveKey(k, v)) items[k] = v;
      if (!Object.keys(items).length) throw new Error('The file has no game saves in it.');
      await queueRestore(items, `the saves in ${f.name}`);
    } catch (err) {
      say(err.message || String(err));
    }
  });

  $('deleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete all of the extension\'s backups? The saves inside the games are not affected.')) return;
    await chrome.storage.local.remove(['saves', 'pendingRestore']);
    say('Backups deleted.', true);
    load();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.saves || changes.pendingRestore)) load();
  });

  load();
})();
