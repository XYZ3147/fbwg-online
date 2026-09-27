// Host side. Runs in the game's /play frame (extension isolated world).
// Streams the game canvas (+ sound) to one guest over WebRTC and replays the
// guest's key/mouse input into the game.
(() => {
  if (window.__fbwgHost) return;
  window.__fbwgHost = true;

  const { ROLE_KEYS, ROLE_NAMES, DIRECTIONS, newCode, peerIdFor, peerOptions, otherRole, layoutFor, LAYOUT_KEYS } = FBWG;

  const state = {
    status: 'idle', // idle | starting | waiting | connected | error
    error: '',
    code: '',
    guestRole: 'watergirl',
    rtt: null,
  };

  let peer = null;
  let conn = null;
  let fast = null; // unordered channel for keys and pings; conn stays ordered for clicks and control
  let lastKeySeq = -1;
  let call = null;
  let stream = null;
  let held = {}; // direction -> bool, what we've told the game the guest is holding
  let mouseDown = false;
  let codeRetries = 0;
  let lastSeen = 0;
  let reconnectDelay = 1000;
  // Tunable from the update file without a new version.
  let settings = FBWG.cleanSettings(null);
  FBWG.loadSettings().then((s) => { settings = s; });
  // The host's own key layout and controller setup (Controls page).
  let controls = FBWG.cleanControls(null);
  FBWG.loadControls().then((c) => { controls = c; applyHostInput(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.controls) {
      controls = FBWG.cleanControls(changes.controls.newValue);
      applyHostInput();
    }
  });
  let padTimer = null;
  let padHeld = {}; // what the host's controller is holding, as host-character keys

  // ---------- talking to the page-world hook ----------
  function sendKey(type, k) {
    document.dispatchEvent(new CustomEvent('fbwg-key', {
      detail: JSON.stringify({ type, key: k.key, code: k.code, keyCode: k.keyCode }),
    }));
  }

  // Keep the game running while its tab is hidden, only while hosting.
  function setBackgroundMode(on) {
    document.dispatchEvent(new CustomEvent('fbwg-background', { detail: on ? 'on' : 'off' }));
  }

  const hostRole = () => otherRole(state.guestRole);

  // While a friend is connected: the host's chosen keys drive the host's
  // character, other movement keys are ignored, and a controller works too.
  function applyHostInput() {
    const active = state.status === 'connected';
    const map = {};
    const block = [];
    if (active) {
      const physical = LAYOUT_KEYS[layoutFor(hostRole(), controls.keyboard)];
      const target = ROLE_KEYS[hostRole()];
      for (const d of DIRECTIONS) map[physical[d].keyCode] = target[d];
      for (const set of Object.values(LAYOUT_KEYS)) {
        for (const d of DIRECTIONS) if (!(set[d].keyCode in map)) block.push(set[d].keyCode);
      }
    }
    document.dispatchEvent(new CustomEvent('fbwg-remap', { detail: JSON.stringify({ map, block }) }));

    const wantPad = active && controls.gamepad.enabled;
    if (wantPad && !padTimer) padTimer = setInterval(pollPad, 16);
    if (!wantPad && padTimer) {
      clearInterval(padTimer);
      padTimer = null;
      setPad({});
    }
  }

  function setPad(next) {
    const keys = ROLE_KEYS[hostRole()];
    for (const dir of DIRECTIONS) {
      const want = !!next[dir];
      if (want !== !!padHeld[dir]) {
        sendKey(want ? 'keydown' : 'keyup', keys[dir]);
        padHeld[dir] = want;
      }
    }
  }

  function pollPad() {
    if (document.hidden) return; // controllers can't be read from a hidden tab
    setPad(FBWG.readGamepads(controls.gamepad));
  }

  function setHeld(next) {
    const keys = ROLE_KEYS[state.guestRole];
    for (const dir of DIRECTIONS) {
      const want = !!next[dir];
      if (want !== !!held[dir]) {
        sendKey(want ? 'keydown' : 'keyup', keys[dir]);
        held[dir] = want;
      }
    }
  }

  function releaseAll() {
    setHeld({});
    if (mouseDown) {
      mouseDown = false;
      const c = findCanvas();
      if (c) c.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    }
  }

  // ---------- game canvas + media ----------
  function findCanvas() {
    let best = null;
    let bestArea = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const area = c.clientWidth * c.clientHeight;
      if (area > bestArea) { best = c; bestArea = area; }
    }
    return best;
  }

  function audioTrack() {
    const el = document.getElementById('fbwg-audio-tap');
    const src = el && el.srcObject;
    return src && src.getAudioTracks ? src.getAudioTracks()[0] || null : null;
  }

  function buildStream() {
    const canvas = findCanvas();
    if (!canvas) throw new Error('Game canvas not found. Wait for the game to load, then try again.');
    const s = canvas.captureStream(60);
    const video = s.getVideoTracks()[0];
    if (video) video.contentHint = 'motion';
    const audio = audioTrack();
    if (audio) s.addTrack(audio);
    return s;
  }

  function tuneSenders(pc) {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = settings.maxBitrate;
      params.encodings[0].maxFramerate = settings.maxFramerate;
      const width = sender.track.getSettings().width || 0;
      params.encodings[0].scaleResolutionDownBy = Math.max(1, width / settings.maxWidth);
      params.degradationPreference = 'maintain-framerate';
      sender.setParameters(params).catch(() => {});
    }
  }

  function startCall(guestPeerId) {
    stream = buildStream();
    const thisCall = peer.call(guestPeerId, stream);
    call = thisCall;
    const pc = thisCall.peerConnection;
    if (pc) {
      const tune = () => {
        if (pc.connectionState === 'connected') tuneSenders(pc);
        if (conn && conn.open) conn.send({ t: 'hostVideo', s: pc.connectionState });
      };
      pc.addEventListener('connectionstatechange', tune);
      tune();
    }
    thisCall.on('close', () => { if (call === thisCall) call = null; });
    thisCall.on('error', () => {});
  }

  // Sound may start after the call (the game creates its AudioContext on first
  // click). Re-call with the audio track added once it shows up.
  document.addEventListener('fbwg-audio-ready', () => {
    if (state.status !== 'connected' || !conn || !stream || stream.getAudioTracks().length) return;
    setTimeout(() => {
      if (state.status !== 'connected' || !conn) return;
      if (call) call.close();
      stopStream();
      try { startCall(conn.peer); } catch (e) { console.warn('[FBWG] re-call failed', e); }
    }, 300);
  });

  function stopStream() {
    if (stream) stream.getVideoTracks().forEach((t) => t.stop());
    stream = null;
  }

  // ---------- guest connection ----------
  function onGuestData(msg, from) {
    if (!msg || typeof msg !== 'object') return;
    lastSeen = Date.now();
    switch (msg.t) {
      case 'keys':
        // Unordered delivery: ignore a state older than one already applied.
        if (typeof msg.seq === 'number') {
          if (msg.seq <= lastKeySeq) break;
          lastKeySeq = msg.seq;
        }
        setHeld(msg.k || {});
        break;
      case 'mouse':
        replayMouse(msg);
        break;
      case 'ping':
        if (from && from.open) from.send({ t: 'pong', ts: msg.ts });
        if (typeof msg.rtt === 'number') { state.rtt = msg.rtt; render(); }
        break;
    }
  }

  function replayMouse(msg) {
    if (!['mousemove', 'mousedown', 'mouseup'].includes(msg.type)) return;
    const c = findCanvas();
    if (!c) return;
    const r = c.getBoundingClientRect();
    const x = r.left + Math.min(1, Math.max(0, +msg.x || 0)) * r.width;
    const y = r.top + Math.min(1, Math.max(0, +msg.y || 0)) * r.height;
    const fire = (type) => c.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      screenX: x, screenY: y, button: 0, buttons: mouseDown ? 1 : 0, view: window,
    }));
    // Buttons in the game only react to a press if the pointer is already over them.
    if (msg.type === 'mousedown') fire('mousemove');
    if (msg.type === 'mousedown') mouseDown = true;
    if (msg.type === 'mouseup') mouseDown = false;
    fire(msg.type);
  }

  function acceptGuest(c) {
    // A newer attempt replaces one that never finished connecting.
    if (conn && !conn.open) {
      const stale = conn;
      conn = null;
      try { stale.close(); } catch {}
    }
    conn = c;
    held = {};
    lastKeySeq = -1;
    lastSeen = Date.now();
    c.on('open', () => {
      lastSeen = Date.now();
      state.status = 'connected';
      state.rtt = null;
      c.send({ t: 'hello', role: state.guestRole });
      try {
        startCall(c.peer);
      } catch (e) {
        c.send({ t: 'error', message: e.message });
      }
      applyHostInput();
      render();
    });
    c.on('data', (m) => onGuestData(m, c));
    const drop = () => {
      if (conn !== c) return;
      releaseAll();
      conn = null;
      if (fast) { try { fast.close(); } catch {} }
      fast = null;
      try { c.close(); } catch {}
      if (call) call.close();
      call = null;
      stopStream();
      if (state.status === 'connected') state.status = 'waiting';
      state.rtt = null;
      applyHostInput();
      render();
    };
    c.on('close', drop);
    c.on('error', drop);
    c.__fbwgDrop = drop;
  }

  // Only the current guest may add a fast channel; it lives and dies with their main one.
  function acceptFast(c) {
    if (!conn || c.peer !== conn.peer) {
      setTimeout(() => { try { c.close(); } catch {} }, 0);
      return;
    }
    if (fast && fast !== c) { try { fast.close(); } catch {} }
    fast = c;
    c.on('data', (m) => onGuestData(m, c));
    const gone = () => { if (fast === c) fast = null; };
    c.on('close', gone);
    c.on('error', gone);
  }

  // The guest pings every second. If it goes silent (crash, network loss) free
  // the slot so they can rejoin instead of being told the game is full.
  // A connection that never finishes opening is dropped the same way.
  setInterval(() => {
    if (!conn || Date.now() - lastSeen < settings.guestTimeoutMs) return;
    conn.__fbwgDrop();
  }, 2000);

  function startHosting(opts = {}) {
    if (opts.guestRole === 'fireboy' || opts.guestRole === 'watergirl') state.guestRole = opts.guestRole;
    if (peer) return;
    state.status = 'starting';
    state.error = '';
    state.code = newCode();
    setBackgroundMode(true);
    render();

    peer = new Peer(peerIdFor(state.code), peerOptions(settings));
    peer.on('open', () => {
      codeRetries = 0;
      state.status = conn ? 'connected' : 'waiting';
      render();
    });
    peer.on('connection', (c) => {
      if (c.metadata && c.metadata.kind === 'fast') {
        acceptFast(c);
        return;
      }
      const returning = c.metadata && c.metadata.guestId && conn && conn.metadata
        && conn.metadata.guestId === c.metadata.guestId;
      if (returning) {
        conn.__fbwgDrop();
      } else if (conn && conn.open) {
        c.on('open', () => c.send({ t: 'full' }));
        setTimeout(() => { try { c.close(); } catch {} }, 3000);
        return;
      }
      acceptGuest(c);
    });
    peer.on('open', () => { reconnectDelay = 1000; });
    peer.on('disconnected', () => {
      // Lost the signalling server; an existing game connection keeps working.
      // Retry with backoff so an outage doesn't mean a reconnect every second.
      const p = peer;
      if (!p || p.destroyed) return;
      setTimeout(() => { if (p === peer && !p.destroyed && p.disconnected) p.reconnect(); }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && codeRetries++ < 5) {
        stopHosting();
        startHosting();
        return;
      }
      if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        if (state.status === 'connected') return;
      }
      if (err.type === 'peer-unavailable') return;
      console.warn('[FBWG] peer error', err);
      state.status = 'error';
      state.error = friendlyError(err);
      render();
    });
  }

  function friendlyError(err) {
    switch (err.type) {
      case 'browser-incompatible': return 'This browser does not support WebRTC.';
      case 'network':
      case 'socket-error':
      case 'socket-closed':
      case 'server-error': return 'Could not reach the connection server. Check your internet and try again.';
      case 'unavailable-id': return 'Could not reserve a room code. Try again.';
      default: return err.message || String(err.type || err);
    }
  }

  function stopHosting() {
    releaseAll();
    if (conn) { try { conn.close(); } catch {} }
    if (fast) { try { fast.close(); } catch {} }
    if (call) { try { call.close(); } catch {} }
    conn = null;
    fast = null;
    call = null;
    stopStream();
    if (peer) { try { peer.destroy(); } catch {} }
    peer = null;
    setBackgroundMode(false);
    state.status = 'idle';
    state.code = '';
    state.error = '';
    state.rtt = null;
    applyHostInput();
    render();
  }

  function setGuestRole(role) {
    if (role !== 'fireboy' && role !== 'watergirl') return;
    if (role === state.guestRole) return;
    releaseAll();
    setPad({});
    state.guestRole = role;
    applyHostInput();
    if (conn && conn.open) conn.send({ t: 'role', role });
    render();
  }

  window.addEventListener('pagehide', stopHosting);
  // The stream's size follows the canvas, so re-apply the width cap on resize.
  window.addEventListener('resize', () => {
    const pc = call && call.peerConnection;
    if (pc && pc.connectionState === 'connected') setTimeout(() => tuneSenders(pc), 250);
  });

  // ---------- on-page status pill ----------
  let pill = null;
  function render() {
    if (state.status === 'idle') {
      if (pill) pill.remove();
      pill = null;
      return;
    }
    if (!pill) {
      pill = document.createElement('div');
      pill.style.cssText = [
        'position:fixed', 'top:8px', 'left:8px', 'z-index:2147483647', 'pointer-events:none',
        'font:600 12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif', 'color:#fff',
        'background:rgba(15,18,28,.82)', 'padding:6px 10px', 'border-radius:999px',
        'box-shadow:0 2px 8px rgba(0,0,0,.35)', 'display:flex', 'gap:6px', 'align-items:center',
      ].join(';');
      (document.body || document.documentElement).appendChild(pill);
    }
    const dot = { starting: '#f5b400', waiting: '#f5b400', connected: '#2ecc71', error: '#ff5a5a' }[state.status];
    let text;
    if (state.status === 'starting') text = 'Starting online room…';
    else if (state.status === 'waiting') text = `Room ${state.code} · waiting for your friend`;
    else if (state.status === 'connected') {
      text = `Friend connected as ${ROLE_NAMES[state.guestRole]}`;
      if (state.rtt != null) text += ` · ${Math.round(state.rtt)} ms`;
    } else text = `Online play error: ${state.error}`;
    pill.innerHTML = '';
    const d = document.createElement('span');
    d.style.cssText = `width:8px;height:8px;border-radius:50%;background:${dot};flex:none`;
    const t = document.createElement('span');
    t.textContent = text;
    pill.append(d, t);
  }

  function publicState() {
    const layout = FBWG.layoutFor(hostRole(), controls.keyboard);
    return { ...state, hasCanvas: !!findCanvas(), hostRole: hostRole(), hostKeys: FBWG.LAYOUT_NAMES[layout] };
  }

  // ---------- popup messages ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.to !== 'fbwg-host') return;
    switch (msg.type) {
      case 'status': break;
      case 'start': startHosting(msg); break;
      case 'stop':
        if (conn && conn.open) {
          try { conn.send({ t: 'bye' }); } catch {}
          setTimeout(() => { stopHosting(); reply(publicState()); }, 300);
          return true;
        }
        stopHosting();
        break;
      case 'role': setGuestRole(msg.role); break;
      default: return;
    }
    reply(publicState());
  });
})();
