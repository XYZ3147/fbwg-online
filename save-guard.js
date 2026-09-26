// Backs up the games' own saves (in the site's localStorage) to the extension's
// storage, and puts them back if the site's copy goes missing. Runs in every
// supported game frame at document_start, before the game reads its save.
(() => {
  if (window.__fbwgSaveGuard) return;
  window.__fbwgSaveGuard = true;

  const { isSaveKey, SAVE_HISTORY_MAX } = FBWG;
  const SNAPSHOT_EVERY_MS = 15000;
  const HISTORY_SPACING_MS = 10 * 60 * 1000;
  const MAX_BYTES = 2 * 1024 * 1024;

  let lastSig = null;
  let ready = false;

  function readSaves() {
    const items = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        if (isSaveKey(k, v)) items[k] = v;
      }
    } catch {}
    return items;
  }

  function writeSaves(items, overwrite) {
    let n = 0;
    for (const [k, v] of Object.entries(items || {})) {
      if (typeof v !== 'string' || !isSaveKey(k, v)) continue;
      try {
        if (!overwrite && localStorage.getItem(k) != null) continue;
        localStorage.setItem(k, v);
        n++;
      } catch {}
    }
    return n;
  }

  function toast(text) {
    const show = () => {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = [
        'position:fixed', 'bottom:12px', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483647',
        'pointer-events:none', 'font:600 13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif', 'color:#fff',
        'background:rgba(15,18,28,.9)', 'padding:8px 14px', 'border-radius:999px', 'transition:opacity .4s',
      ].join(';');
      document.documentElement.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; }, 5000);
      setTimeout(() => el.remove(), 5600);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }

  async function restore() {
    const { saves, pendingRestore, autoRestore = true } = await chrome.storage.local.get(['saves', 'pendingRestore', 'autoRestore']);
    if (pendingRestore && pendingRestore.items) {
      const n = writeSaves(pendingRestore.items, true);
      await chrome.storage.local.remove('pendingRestore');
      if (n) toast(`Fireboy & Watergirl Online restored ${n} saved game${n > 1 ? 's' : ''} from your backup.`);
      return;
    }
    if (autoRestore && saves && saves.current) {
      const n = writeSaves(saves.current.items, false);
      if (n) toast(`Your progress was missing, so it was restored from the extension's backup (${n} game${n > 1 ? 's' : ''}).`);
    }
  }

  async function snapshot() {
    if (!ready) return;
    const items = readSaves();
    const sig = JSON.stringify(items);
    if (sig === lastSig) return;
    if (!Object.keys(items).length || sig.length > MAX_BYTES) return; // never replace a backup with nothing
    lastSig = sig;
    const { saves = { current: null, history: [] } } = await chrome.storage.local.get('saves');
    if (saves.current && JSON.stringify(saves.current.items) === sig) return;
    const now = Date.now();
    const history = Array.isArray(saves.history) ? saves.history : [];
    // Keep older versions spaced out, so a bad save can't push out all the good ones.
    if (saves.current && now - saves.current.updated > HISTORY_SPACING_MS) {
      history.unshift(saves.current);
      history.length = Math.min(history.length, SAVE_HISTORY_MAX);
    }
    await chrome.storage.local.set({ saves: { current: { items, updated: now }, history } });
  }

  restore()
    .catch((e) => console.warn('[FBWG] restoring saves failed', e))
    .finally(() => {
      ready = true;
      setInterval(() => snapshot().catch(() => {}), SNAPSHOT_EVERY_MS);
    });
  window.addEventListener('pagehide', () => { snapshot().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot().catch(() => {}); });
})();
