// Runs only on the invite page (GitHub Pages). Tells the page the extension is
// installed and opens the game window when the player clicks Join.
(() => {
  const root = document.documentElement;
  root.dataset.fbwg = 'installed';
  document.dispatchEvent(new CustomEvent('fbwg-installed'));

  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-fbwg-join]');
    if (!btn) return;
    e.preventDefault();
    const code = FBWG.normalizeCode(location.hash.slice(1));
    if (code.length !== FBWG.CODE_LENGTH) return;
    chrome.runtime.sendMessage({ to: 'fbwg-bg', type: 'openViewer', code }).catch(() => {});
    btn.textContent = 'Opening the game…';
    setTimeout(() => { btn.textContent = 'Join the game'; }, 3000);
  });
})();
