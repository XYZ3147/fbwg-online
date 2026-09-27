(() => {
  const { DIRECTIONS, ACTION_NAMES, DEFAULT_CONTROLS, cleanControls, bindingLabel, readPad } = FBWG;
  const $ = (id) => document.getElementById(id);
  const ORDER = ['left', 'right', 'up', 'down'];
  const CAPTURE_MS = 10000;

  let controls = cleanControls(null);
  let players = FBWG.cleanPlayers(null);
  FBWG.loadPlayers().then((p) => { players = p; lastListSig = ''; });
  let capture = null; // { dir, baseline, until } while waiting for a button press

  async function save() {
    await chrome.storage.local.set({ controls });
  }

  function say(text) {
    $('msg').textContent = text;
  }

  function firstPad() {
    if (!navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected) return p;
    return null;
  }

  // ---------- rendering ----------
  function renderKeyboard() {
    for (const r of document.querySelectorAll('input[name="keyboard"]')) r.checked = r.value === controls.keyboard;
  }

  function renderBindings() {
    const tbody = $('bindingRows');
    tbody.textContent = '';
    for (const dir of ORDER) {
      const tr = document.createElement('tr');
      tr.dataset.dir = dir;
      const name = document.createElement('td');
      name.className = 'action';
      name.textContent = ACTION_NAMES[dir];
      const list = document.createElement('td');
      if (capture && capture.dir === dir) {
        const w = document.createElement('span');
        w.className = 'waiting';
        w.textContent = 'Press a button or push a stick… (Esc to cancel)';
        list.append(w);
      } else if (!controls.gamepad.bindings[dir].length) {
        const n = document.createElement('span');
        n.className = 'none';
        n.textContent = 'Nothing set';
        list.append(n);
      }
      controls.gamepad.bindings[dir].forEach((b, i) => {
        const chip = document.createElement('span');
        chip.className = 'chip-b';
        chip.append(bindingLabel(b));
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.title = 'Remove';
        x.setAttribute('aria-label', `Remove ${bindingLabel(b)} from ${ACTION_NAMES[dir]}`);
        x.addEventListener('click', () => {
          controls.gamepad.bindings[dir].splice(i, 1);
          save();
          renderBindings();
        });
        chip.append(x);
        list.append(chip);
      });
      const add = document.createElement('td');
      add.className = 'add';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = capture && capture.dir === dir ? 'Cancel' : 'Add';
      btn.disabled = controls.gamepad.bindings[dir].length >= 4 && !(capture && capture.dir === dir);
      btn.addEventListener('click', () => (capture && capture.dir === dir ? stopCapture('') : startCapture(dir)));
      add.append(btn);
      tr.append(name, list, add);
      tbody.append(tr);
    }
  }

  function renderPadOptions() {
    $('padEnabled').checked = controls.gamepad.enabled;
    $('deadzone').value = controls.gamepad.deadzone;
    $('deadzoneOut').textContent = controls.gamepad.deadzone.toFixed(2);
    for (const el of [$('deadzone'), $('resetBtn')]) el.disabled = !controls.gamepad.enabled;
    document.querySelector('.bindings').style.opacity = controls.gamepad.enabled ? '' : '.5';
  }

  function renderAll() {
    renderKeyboard();
    renderPadOptions();
    renderBindings();
  }

  // ---------- capturing a new button ----------
  function snapshot(pad) {
    return { buttons: pad.buttons.map((b) => b.pressed), axes: pad.axes.slice() };
  }

  function startCapture(dir) {
    const pad = firstPad();
    if (!pad) {
      say('Connect a controller and press any button on it first.');
      return;
    }
    capture = { dir, baseline: snapshot(pad), until: performance.now() + CAPTURE_MS };
    say('');
    renderBindings();
  }

  function stopCapture(message) {
    capture = null;
    say(message);
    renderBindings();
  }

  // Something newly pressed compared with when "Add" was clicked.
  function detect(pad) {
    const base = capture.baseline;
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pad.buttons[i].pressed && !base.buttons[i]) return { type: 'button', index: i };
    }
    for (let i = 0; i < pad.axes.length; i++) {
      const v = pad.axes[i];
      if (Math.abs(v) > 0.6 && Math.abs(base.axes[i] || 0) < 0.3) return { type: 'axis', index: i, dir: v > 0 ? 1 : -1 };
    }
    return null;
  }

  function sameBinding(a, b) {
    return a.type === b.type && a.index === b.index && (a.type === 'button' || a.dir === b.dir);
  }

  // Every connected controller and the character it plays (set on the Players screen).
  let lastListSig = '';
  function renderPadList() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
    const sig = JSON.stringify([pads.map(FBWG.padKey), players]);
    if (sig === lastListSig) return;
    lastListSig = sig;
    const ul = $('padList');
    ul.textContent = '';
    pads.forEach((p, i) => {
      const side = players.pads[FBWG.padKey(p)] || 'none';
      const li = document.createElement('li');
      li.append(`Controller ${i + 1} (${FBWG.padName(p)}): `);
      const s = document.createElement('span');
      s.className = side === 'fireboy' ? 'fire' : side === 'watergirl' ? 'water' : '';
      s.textContent = side === 'none' ? 'no side chosen (plays your character when you host)' : FBWG.ROLE_NAMES[side];
      li.append(s);
      ul.append(li);
    });
    ul.hidden = !pads.length;
  }

  // ---------- live loop: capture + highlight active actions ----------
  let lastPadId = null;
  function loop() {
    renderPadList();
    const pad = firstPad();
    const id = pad ? pad.id : null;
    if (id !== lastPadId) {
      lastPadId = id;
      $('padStatus').textContent = pad
        ? `Controller connected: ${pad.id.replace(/\s*\(.*$/, '') || 'controller'}. Press buttons to test; the matching action lights up.`
        : 'No controller found. Connect one and press any button on it.';
    }

    if (capture) {
      if (!pad || performance.now() > capture.until) {
        stopCapture(pad ? 'Nothing was pressed. Click Add to try again.' : 'The controller was disconnected.');
      } else {
        const b = detect(pad);
        if (b) {
          const dir = capture.dir;
          // Each button does one action: take it off wherever it was, then add it here.
          for (const d of DIRECTIONS) {
            controls.gamepad.bindings[d] = controls.gamepad.bindings[d].filter((x) => !sameBinding(x, b));
          }
          controls.gamepad.bindings[dir].push(b);
          save();
          stopCapture(`${bindingLabel(b)} now does ${ACTION_NAMES[dir]}.`);
        }
      }
    }

    const active = pad && controls.gamepad.enabled ? readPad(pad, controls.gamepad) : {};
    for (const tr of document.querySelectorAll('#bindingRows tr')) tr.classList.toggle('active', !!active[tr.dataset.dir]);
  }

  // ---------- events ----------
  for (const r of document.querySelectorAll('input[name="keyboard"]')) {
    r.addEventListener('change', () => {
      controls.keyboard = r.value;
      save();
    });
  }
  $('padEnabled').addEventListener('change', (e) => {
    controls.gamepad.enabled = e.target.checked;
    if (!e.target.checked && capture) capture = null;
    save();
    renderAll();
  });
  $('deadzone').addEventListener('input', (e) => {
    controls.gamepad.deadzone = +e.target.value;
    $('deadzoneOut').textContent = controls.gamepad.deadzone.toFixed(2);
  });
  $('deadzone').addEventListener('change', save);
  $('resetBtn').addEventListener('click', () => {
    controls.gamepad.bindings = JSON.parse(JSON.stringify(DEFAULT_CONTROLS.gamepad.bindings));
    controls.gamepad.deadzone = DEFAULT_CONTROLS.gamepad.deadzone;
    capture = null;
    save();
    renderAll();
    say('Controller buttons reset.');
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && capture) stopCapture('');
  });
  $('playersLink').addEventListener('click', () => {
    chrome.windows.create({ url: chrome.runtime.getURL('players.html'), type: 'popup', width: 860, height: 720, focused: true });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.players) { players = FBWG.cleanPlayers(changes.players.newValue); lastListSig = ''; }
    if (area === 'local' && changes.controls && !capture) {
      controls = cleanControls(changes.controls.newValue);
      renderAll();
    }
  });

  FBWG.loadControls().then((c) => {
    controls = c;
    renderAll();
    setInterval(loop, 16);
  });
})();
