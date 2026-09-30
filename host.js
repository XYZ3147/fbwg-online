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
  let fast = null; // extra unordered channel on the same connection, for keys and pings
  let lastKeySeq = -1;
  let stream = null;
  let negotiation = Promise.resolve(); // video setup steps run one at a time
  let awaitingAnswer = null; // resolves when the friend answers a video offer
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
  // Local side selection (Players screen): which character each device plays.
  let players = FBWG.cleanPlayers(null);
  FBWG.loadPlayers().then((p) => { players = p; applyHostInput(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.players) {
      players = FBWG.cleanPlayers(changes.players.newValue);
      applyHostInput();
    }
  });
  const padHeld = { fireboy: {}, watergirl: {} }; // keys controllers are holding, per character
  let quality = 'smooth'; // the friend's Smooth / Sharp choice
  const HOSTING_KEY = 'fbwg-hosting'; // this tab's room, so a reload resumes it

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

  // Which character the keyboard drives here: a character, or 'both' (the
  // game's own keys: arrows for Fireboy, WASD for Watergirl).
  function keyboardRole() {
    if (state.status === 'connected') return hostRole(); // online: only the host's character
    return players.keyboard; // local play: from the Players screen
  }

  // Tell the page hook how to treat real key presses.
  function applyHostInput() {
    const role = keyboardRole();
    const map = {};
    const block = [];
    if (role !== 'both') {
      const physical = LAYOUT_KEYS[layoutFor(role, controls.keyboard)];
      const target = ROLE_KEYS[role];
      for (const d of DIRECTIONS) map[physical[d].keyCode] = target[d];
      for (const set of Object.values(LAYOUT_KEYS)) {
        for (const d of DIRECTIONS) if (!(set[d].keyCode in map)) block.push(set[d].keyCode);
      }
    }
    document.dispatchEvent(new CustomEvent('fbwg-remap', { detail: JSON.stringify({ map, block }) }));
    pollPads();
  }

  function setPadRole(role, next) {
    const keys = ROLE_KEYS[role];
    const heldNow = padHeld[role];
    for (const dir of DIRECTIONS) {
      const want = !!next[dir];
      if (want !== !!heldNow[dir]) {
        sendKey(want ? 'keydown' : 'keyup', keys[dir]);
        heldNow[dir] = want;
      }
    }
  }

  // Which character each connected controller drives right now.
  function padRoles(pads) {
    const out = new Map();
    const online = state.status === 'connected';
    for (const p of pads) {
      const side = players.pads[FBWG.padKey(p)] || 'none';
      if (online) {
        if (side === hostRole()) out.set(p, hostRole());
      } else if (side === 'fireboy' || side === 'watergirl') {
        out.set(p, side);
      }
    }
    // Online with no controller put on the host's side: the first one plays the host.
    if (online && !out.size && pads.length) out.set(pads[0], hostRole());
    return out;
  }

  function pollPads() {
    let pads = [];
    if (controls.gamepad.enabled && !document.hidden && navigator.getGamepads) {
      pads = [...navigator.getGamepads()].filter((p) => p && p.connected);
    }
    const want = { fireboy: {}, watergirl: {} };
    for (const [pad, role] of padRoles(pads)) {
      const a = FBWG.readPad(pad, controls.gamepad);
      for (const d of DIRECTIONS) if (a[d]) want[role][d] = true;
    }
    // The friend's character is theirs while they're connected.
    if (state.status === 'connected') want[state.guestRole] = {};
    setPadRole('fireboy', want.fireboy);
    setPadRole('watergirl', want.watergirl);
  }
  setInterval(pollPads, 16);

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
      // Sharp (the friend's choice): larger picture and more bits, for fast connections.
      // Capped at 1280 px: bigger costs frames (tested: 1800 px fell to ~10 fps) and
      // adds little, since the games themselves are 640 to 1024 px.
      const sharp = quality === 'sharp';
      params.encodings[0].maxBitrate = sharp ? Math.max(settings.maxBitrate, 6000000) : settings.maxBitrate;
      params.encodings[0].maxFramerate = settings.maxFramerate;
      const width = sender.track.getSettings().width || 0;
      const maxWidth = sharp ? Math.max(settings.maxWidth, 1280) : settings.maxWidth;
      params.encodings[0].scaleResolutionDownBy = Math.max(1, width / maxWidth);
      params.degradationPreference = 'maintain-framerate';
      sender.setParameters(params).catch(() => {});
    }
  }

  // Video and sound travel on the SAME connection as the controls. A separate
  // video connection had to find its own way through both networks and could
  // fail on strict ones even though the controls were connected.
  const mediaPc = () => (conn && conn.peerConnection) || null;

  // Agree the new tracks with the friend through the already-open channel.
  function renegotiate(c) {
    negotiation = negotiation.then(async () => {
      const pc = c.peerConnection;
      if (conn !== c || !c.open || !pc) return;
      const answered = new Promise((resolve, reject) => {
        awaitingAnswer = { resolve, reject };
        setTimeout(() => reject(new Error('the friend did not answer the video offer')), 15000);
      });
      answered.catch(() => {}); // handled by the await below; avoids a stray warning if we bail out first
      await pc.setLocalDescription(await pc.createOffer());
      c.send({ t: 'sdp', d: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      await pc.setRemoteDescription(await answered);
      tuneSenders(pc);
    }).catch((e) => {
      console.warn('[FBWG] video setup failed', e);
      if (conn === c && c.open) c.send({ t: 'error', message: e.message || String(e) });
    }).finally(() => { awaitingAnswer = null; });
  }

  function startMedia(c) {
    const pc = c.peerConnection;
    if (!pc) throw new Error('No connection to send video over.');
    stream = buildStream();
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    renegotiate(c);
  }

  // Sound may start after the video (the game creates its AudioContext on the
  // first click): add the audio track then.
  document.addEventListener('fbwg-audio-ready', () => {
    if (state.status !== 'connected' || !conn || !stream || stream.getAudioTracks().length) return;
    const c = conn;
    setTimeout(() => {
      const pc = c.peerConnection;
      const audio = audioTrack();
      if (conn !== c || !pc || !stream || !audio || stream.getAudioTracks().length) return;
      stream.addTrack(audio);
      pc.addTrack(audio, stream);
      renegotiate(c);
    }, 300);
  });

  // The friend's fast channel arrives on the same connection. PeerJS would
  // treat any new channel as its own, so take over the handler.
  function watchForFastChannel(c) {
    const pc = c.peerConnection;
    if (!pc) return;
    pc.ondatachannel = (e) => {
      if (e.channel.label !== FBWG.FAST_LABEL || conn !== c) return;
      const ch = e.channel;
      const wrap = {
        get open() { return ch.readyState === 'open'; },
        send(msg) { if (ch.readyState === 'open') ch.send(JSON.stringify(msg)); },
        close() { try { ch.close(); } catch {} },
      };
      ch.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        onGuestData(m, wrap);
      };
      ch.onclose = () => { if (fast === wrap) fast = null; };
      if (fast) fast.close();
      fast = wrap;
    };
  }

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
      case 'sdp':
        if (awaitingAnswer && msg.d && msg.d.type === 'answer') awaitingAnswer.resolve(msg.d);
        break;
      case 'signal':
        showSignal(msg, state.guestRole);
        break;
      case 'quality':
        if (msg.mode === 'sharp' || msg.mode === 'smooth') {
          quality = msg.mode;
          const pc = mediaPc();
          if (pc && stream) tuneSenders(pc);
        }
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
      // Both players need the same connection design.
      if (!c.metadata || c.metadata.proto !== FBWG.PROTO) {
        c.send({ t: 'error', message: 'your extension is out of date. Double-click Update.cmd in your extension folder, then join again.' });
        setTimeout(() => { if (conn === c) c.__fbwgDrop(); }, 3000);
        return;
      }
      state.status = 'connected';
      state.rtt = null;
      watchForFastChannel(c);
      c.send({ t: 'hello', role: state.guestRole, proto: FBWG.PROTO });
      try {
        startMedia(c);
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
      if (awaitingAnswer) awaitingAnswer.reject(new Error('the friend disconnected'));
      try { c.close(); } catch {}
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
    state.code = opts.code || newCode();
    const resuming = !!opts.code;
    try { sessionStorage.setItem(HOSTING_KEY, JSON.stringify({ code: state.code, guestRole: state.guestRole })); } catch {}
    setBackgroundMode(true);
    render();

    peer = new Peer(peerIdFor(state.code), peerOptions(settings));
    peer.on('open', () => {
      codeRetries = 0;
      state.status = conn ? 'connected' : 'waiting';
      render();
    });
    peer.on('connection', (c) => {
      // Older versions opened a second connection for fast keys; not used any more.
      if (c.metadata && c.metadata.kind === 'fast') {
        setTimeout(() => { try { c.close(); } catch {} }, 0);
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
      if (err.type === 'unavailable-id') {
        // After a reload the server may still hold the old connection for a
        // few seconds: keep trying the same code, then fall back to a new one.
        const again = resuming && codeRetries < 10 ? state.code : undefined;
        if (codeRetries++ < 15) {
          const role = state.guestRole;
          teardownHosting();
          setTimeout(() => startHosting({ guestRole: role, code: again }), again ? 2000 : 0);
          return;
        }
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

  // Stop on purpose: forget the room so a reload doesn't bring it back.
  function stopHosting() {
    try { sessionStorage.removeItem(HOSTING_KEY); } catch {}
    teardownHosting();
  }

  function teardownHosting() {
    releaseAll();
    if (conn) { try { conn.close(); } catch {} }
    if (fast) { try { fast.close(); } catch {} }
    conn = null;
    fast = null;
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
    setPadRole('fireboy', {});
    setPadRole('watergirl', {});
    state.guestRole = role;
    applyHostInput();
    if (conn && conn.open) conn.send({ t: 'role', role });
    render();
  }

  // Leaving or reloading the page keeps the room remembered for this tab.
  window.addEventListener('pagehide', teardownHosting);

  // After a reload (or a crashed tab coming back), host the same room again so
  // the friend's automatic reconnect finds it.
  (function resumeHosting() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(HOSTING_KEY) || 'null'); } catch {}
    if (!saved || !saved.code) return;
    let tries = 0;
    const wait = setInterval(() => {
      if (findCanvas() || ++tries > 120) {
        clearInterval(wait);
        if (findCanvas() && !peer) startHosting({ guestRole: saved.guestRole, code: FBWG.normalizeCode(saved.code) });
      }
    }, 500);
  })();
  // The stream's size follows the canvas, so re-apply the width cap on resize.
  window.addEventListener('resize', () => {
    const pc = mediaPc();
    if (pc && stream) setTimeout(() => { if (mediaPc() === pc) tuneSenders(pc); }, 250);
  });

  // ---------- quick signals ----------
  // Messages (keys 1–4) and "look here" markers (Alt+click), shown on both screens.
  function sendSignal(sig) {
    if (conn && conn.open) conn.send({ t: 'signal', ...sig });
    showSignal(sig, hostRole());
  }

  let signalLayer = null;
  function layer() {
    const c = findCanvas();
    if (!c) return null;
    if (!signalLayer) {
      signalLayer = document.createElement('div');
      signalLayer.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;overflow:hidden';
      (document.body || document.documentElement).appendChild(signalLayer);
      FBWG.injectSignalStyles(document);
    }
    const r = c.getBoundingClientRect();
    Object.assign(signalLayer.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    return signalLayer;
  }

  function showSignal(sig, from) {
    const l = layer();
    if (l) FBWG.renderSignal(l, sig, from);
  }

  window.addEventListener('keydown', (e) => {
    if (state.status !== 'connected' || e.repeat || !e.isTrusted) return;
    const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
    if (i >= 0) sendSignal({ kind: 'msg', i });
  }, true);

  // Alt+click on the game points somewhere; the game itself doesn't see that click.
  const pointClick = (e) => {
    if (state.status !== 'connected' || !e.altKey || !e.isTrusted) return;
    const c = findCanvas();
    if (!c) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type !== 'mousedown') return;
    const r = c.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) sendSignal({ kind: 'mark', x, y });
  };
  for (const t of ['mousedown', 'mouseup', 'click']) window.addEventListener(t, pointClick, true);

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
      text += ' · 1–4 to signal, Alt+click to point';
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
