(() => {
  const { cleanPlayers, padKey, padName, LAYOUT_NAMES, layoutFor, ROLE_NAMES } = FBWG;
  const $ = (id) => document.getElementById(id);

  // Left to right, like the columns on screen.
  const PAD_SIDES = ['fireboy', 'none', 'watergirl'];
  const KEY_SIDES = ['fireboy', 'both', 'watergirl'];

  let players = cleanPlayers(null);
  let controls = FBWG.cleanControls(null);
  const lastDir = new Map(); // padKey -> -1 | 0 | 1, for one move per push
  const pulseUntil = new Map(); // padKey -> time, card glows while its controller is used

  function save() {
    chrome.storage.local.set({ players });
  }

  function connectedPads() {
    if (!navigator.getGamepads) return [];
    return [...navigator.getGamepads()].filter((p) => p && p.connected);
  }

  function keyboardWhat(side) {
    if (side === 'both') return 'Arrow keys: Fireboy · WASD: Watergirl';
    return `${LAYOUT_NAMES[layoutFor(side, controls.keyboard)]} play ${ROLE_NAMES[side]}`;
  }

  function padWhat(side) {
    return side === 'none' ? 'Not playing' : `Plays ${ROLE_NAMES[side]}`;
  }

  function move(kind, key, step) {
    const sides = kind === 'keyboard' ? KEY_SIDES : PAD_SIDES;
    const current = kind === 'keyboard' ? players.keyboard : players.pads[key] || 'none';
    const next = sides[Math.min(sides.length - 1, Math.max(0, sides.indexOf(current) + step))];
    if (next === current) return;
    if (kind === 'keyboard') players.keyboard = next;
    else players.pads[key] = next;
    save();
    render();
  }

  function card(kind, key, name, side, number) {
    const sides = kind === 'keyboard' ? KEY_SIDES : PAD_SIDES;
    const lane = document.createElement('div');
    lane.className = 'lane';
    const dev = document.createElement('div');
    dev.className = `device col-${side}`;
    dev.dataset.key = key;

    const left = document.createElement('button');
    left.type = 'button';
    left.textContent = '◀';
    left.setAttribute('aria-label', `Move ${name} left`);
    left.disabled = side === sides[0];
    left.addEventListener('click', () => move(kind, key, -1));

    const who = document.createElement('div');
    who.className = 'who';
    const n = document.createElement('div');
    n.className = 'name';
    n.textContent = kind === 'keyboard' ? '⌨ Keyboard' : `🎮 ${number}. ${name}`;
    n.title = n.textContent;
    const w = document.createElement('div');
    w.className = 'what';
    w.textContent = kind === 'keyboard' ? keyboardWhat(side) : padWhat(side);
    who.append(n, w);

    const right = document.createElement('button');
    right.type = 'button';
    right.textContent = '▶';
    right.setAttribute('aria-label', `Move ${name} right`);
    right.disabled = side === sides[sides.length - 1];
    right.addEventListener('click', () => move(kind, key, 1));

    dev.append(left, who, right);
    lane.append(dev);
    return lane;
  }

  let lastSig = '';
  function render() {
    const pads = connectedPads();
    const sig = JSON.stringify([players, controls.keyboard, pads.map(padKey)]);
    if (sig === lastSig) return;
    lastSig = sig;

    const lanes = $('lanes');
    lanes.textContent = '';
    lanes.append(card('keyboard', 'keyboard', 'Keyboard', players.keyboard));
    pads.forEach((p, i) => lanes.append(card('pad', padKey(p), padName(p), players.pads[padKey(p)] || 'none', i + 1)));

    const ul = $('summary');
    ul.textContent = '';
    pads.forEach((p, i) => {
      const side = players.pads[padKey(p)] || 'none';
      const li = document.createElement('li');
      li.append(`Controller ${i + 1} (${padName(p)}): `);
      const s = document.createElement('span');
      s.className = side === 'fireboy' ? 'fire' : side === 'watergirl' ? 'water' : '';
      s.textContent = side === 'none' ? 'not playing' : ROLE_NAMES[side];
      li.append(s);
      ul.append(li);
    });
    $('noPads').hidden = pads.length > 0;
    ul.hidden = !pads.length;
  }

  // Controllers move their own card: one step per push of the stick or D-pad.
  function poll() {
    const now = performance.now();
    for (const p of connectedPads()) {
      const key = padKey(p);
      const x = p.axes[0] || 0;
      const btn = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
      const dir = btn(14) || x < -0.6 ? -1 : btn(15) || x > 0.6 ? 1 : 0;
      const prev = lastDir.get(key) || 0;
      if (dir !== 0 && prev === 0) move('pad', key, dir);
      if (Math.abs(x) < 0.3 && !btn(14) && !btn(15)) lastDir.set(key, 0);
      else if (dir !== 0) lastDir.set(key, dir);
      if (p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5)) pulseUntil.set(key, now + 250);
    }
    render();
    for (const el of document.querySelectorAll('.device')) {
      el.classList.toggle('pulse', (pulseUntil.get(el.dataset.key) || 0) > now);
    }
  }

  $('doneBtn').addEventListener('click', () => window.close());
  $('controlsLink').addEventListener('click', () => {
    chrome.windows.create({ url: chrome.runtime.getURL('controls.html'), type: 'popup', width: 560, height: 760, focused: true });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.players) players = cleanPlayers(changes.players.newValue);
    if (changes.controls) controls = FBWG.cleanControls(changes.controls.newValue);
    lastSig = '';
    render();
  });

  Promise.all([FBWG.loadPlayers(), FBWG.loadControls()]).then(([p, c]) => {
    players = p;
    controls = c;
    render();
    setInterval(poll, 16);
  });
})();
