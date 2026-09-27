// Guest side: shows the host's game stream and sends this player's input back.
(() => {
  const { DIRECTIONS, ROLE_NAMES, normalizeCode, peerIdFor, CODE_LENGTH, LAYOUT_KEYS, LAYOUT_NAMES, layoutFor } = FBWG;
  const $ = (id) => document.getElementById(id);

  const els = {
    joinCard: $('joinCard'), joinForm: $('joinForm'), codeInput: $('codeInput'), joinBtn: $('joinBtn'),
    joinMsg: $('joinMsg'), screen: $('screen'), video: $('video'), overlay: $('overlay'),
    info: $('info'), roleChip: $('roleChip'), hint: $('hint'), stats: $('stats'),
    actions: $('actions'), soundBtn: $('soundBtn'), fitBtn: $('fitBtn'), fullBtn: $('fullBtn'), leaveBtn: $('leaveBtn'),
    unmuteBtn: $('unmuteBtn'), controlsBtn: $('controlsBtn'),
  };

  // Movement keys by physical key code; which set counts depends on the Controls page.
  const LAYOUT_CODES = {};
  for (const [layout, keys] of Object.entries(LAYOUT_KEYS)) {
    LAYOUT_CODES[layout] = {};
    for (const d of DIRECTIONS) LAYOUT_CODES[layout][keys[d].code] = d;
  }
  const ALL_MOVE_CODES = new Set(Object.values(LAYOUT_CODES).flatMap(Object.keys));

  let controls = FBWG.cleanControls(null);
  FBWG.loadControls().then((c) => { controls = c; updateHint(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.controls) {
      controls = FBWG.cleanControls(changes.controls.newValue);
      updateHint();
      sendKeys();
    }
  });
  let padState = {}; // actions the controller is pressing

  // Before the host says which character we play, accept both key sets.
  function dirFor(code) {
    if (!role) return LAYOUT_CODES.arrows[code] || LAYOUT_CODES.wasd[code];
    return LAYOUT_CODES[layoutFor(role, controls.keyboard)][code];
  }

  // A stable id for this window, so the host lets us back in after a dropped connection.
  const guestId = (() => {
    try {
      let id = sessionStorage.getItem('fbwg-guest');
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('fbwg-guest', id); }
      return id;
    } catch { return crypto.randomUUID(); }
  })();
  const RECONNECT_FOR_MS = 60000;
  let currentCode = '';
  let reconnect = null; // { until, attempt, timer } while trying to get back in
  let hostSaidBye = false;
  let connectTimer = null;

  let peer = null;
  let conn = null;
  let mediaCall = null;
  let role = null;
  let rtt = null;
  let timers = [];
  let hostHidden = false;
  let gotVideo = false;
  const pressed = new Set(); // physical key codes currently held
  let lastSent = '';
  let fast = null; // unordered channel for keys and pings (no waiting behind a lost packet)
  let keySeq = 0;
  let lastKeyChange = 0;
  let lastKeySend = 0;
  let lastJb = null; // previous jitter-buffer counters, for the delay shown in the stats
  let lastPong = 0;
  let videoStatus = 'Waiting for the host to send the video…';
  // Tunable from the update file without a new version.
  let settings = FBWG.cleanSettings(null);
  FBWG.loadSettings().then((s) => { settings = s; });

  // ---------- UI helpers ----------
  function showJoin(message = '', bad = false) {
    els.joinCard.hidden = false;
    els.screen.hidden = true;
    els.info.hidden = true;
    els.actions.hidden = true;
    els.joinBtn.disabled = false;
    els.joinMsg.textContent = message;
    els.joinMsg.classList.toggle('bad', bad);
    els.codeInput.focus();
  }

  function showScreen() {
    els.joinCard.hidden = true;
    els.screen.hidden = false;
    els.actions.hidden = false;
  }

  function setOverlay(text, withBack = false, withTryAgain = false) {
    els.overlay.textContent = '';
    if (!text) return;
    const wrap = document.createElement('div');
    wrap.textContent = text;
    if (withBack || withTryAgain) wrap.append(document.createElement('br'));
    if (withTryAgain) {
      const again = document.createElement('button');
      again.type = 'button';
      again.textContent = 'Try again';
      again.addEventListener('click', () => {
        reconnect = { until: Date.now() + RECONNECT_FOR_MS, attempt: 0, timer: null };
        retrySoon(0);
      });
      wrap.append(again, ' ');
    }
    if (withBack) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Back to join screen';
      b.addEventListener('click', () => leave());
      wrap.append(b);
    }
    els.overlay.append(wrap);
  }

  function refreshOverlay() {
    if (!conn) return;
    if (hostHidden) setOverlay("The host's game tab isn't visible, so Chrome has paused the game. It resumes when the host brings the game tab back on screen.");
    else if (!gotVideo) setOverlay('Connected. ' + videoStatus);
    else setOverlay('');
  }

  function setVideoStatus(text) {
    videoStatus = text;
    console.info('[FBWG] video:', text);
    refreshOverlay();
  }

  const ICE_TEXT = {
    checking: 'Connecting the video…',
    connected: 'Video connected, waiting for the first frame…',
    completed: 'Video connected, waiting for the first frame…',
    disconnected: 'The video connection dropped, trying to recover…',
    failed: 'The video connection failed. A firewall or strict network is probably blocking it.',
  };

  function watchVideoConnection(pc) {
    if (!pc) return;
    const update = () => { if (ICE_TEXT[pc.iceConnectionState]) setVideoStatus(ICE_TEXT[pc.iceConnectionState]); };
    pc.addEventListener('iceconnectionstatechange', update);
    update();
  }

  function setRole(r) {
    role = r;
    els.info.hidden = false;
    els.roleChip.className = 'chip ' + r;
    els.roleChip.textContent = 'You are ' + ROLE_NAMES[r];
    document.title = `${ROLE_NAMES[r]} · Fireboy & Watergirl Online`;
    updateHint();
  }

  function padConnected() {
    return !!(navigator.getGamepads && [...navigator.getGamepads()].some((p) => p && p.connected));
  }

  function updateHint() {
    if (!role) return;
    const keys = LAYOUT_NAMES[layoutFor(role, controls.keyboard)];
    const pad = controls.gamepad.enabled && padConnected() ? ' or your controller' : '';
    els.hint.textContent = `Move with ${keys}${pad} · click the game to use menus`;
  }
  window.addEventListener('gamepadconnected', updateHint);
  window.addEventListener('gamepaddisconnected', updateHint);

  // ---------- connection ----------
  // With rejoin, the game screen stays up and failures retry instead of
  // going back to the code screen.
  function join(code, rejoin = false) {
    code = normalizeCode(code);
    if (code.length !== CODE_LENGTH) {
      showJoin(`Room codes are ${CODE_LENGTH} characters.`, true);
      return;
    }
    teardown();
    currentCode = code;
    if (!rejoin) {
      stopReconnecting();
      hostSaidBye = false;
      history.replaceState(null, '', '?code=' + code);
      els.joinBtn.disabled = true;
      els.joinMsg.classList.remove('bad');
      els.joinMsg.textContent = 'Connecting…';
    }
    // Give up on this attempt if the connection never opens.
    connectTimer = setTimeout(() => {
      if (conn && conn.open) return;
      if (rejoin) retrySoon();
      else { teardown(); showJoin('Could not reach the host. Check the code and try again.', true); }
    }, 12000);

    peer = new Peer(FBWG.peerOptions(settings));
    peer.on('open', () => {
      conn = peer.connect(peerIdFor(code), { reliable: true, serialization: 'json', metadata: { guestId } });
      conn.on('open', () => {
        clearTimeout(connectTimer);
        stopReconnecting();
        showScreen();
        refreshOverlay();
        startTimers();
        openFastChannel(code);
      });
      conn.on('data', onHostData);
      conn.on('close', () => connectionLost());
      conn.on('error', () => connectionLost());
    });
    peer.on('call', (c) => {
      if (mediaCall && mediaCall !== c) mediaCall.close();
      mediaCall = c;
      setVideoStatus('Video call received, connecting…');
      c.answer();
      watchVideoConnection(c.peerConnection);
      c.on('error', (e) => setVideoStatus('Video call error: ' + (e.message || e.type)));
      c.on('stream', (s) => {
        setVideoStatus('Video connected, waiting for the first frame…');
        tuneReceivers(c.peerConnection);
        els.video.srcObject = s;
        playVideo();
      });
    });
    peer.on('error', (err) => {
      if (rejoin && (!conn || !conn.open)) {
        retrySoon();
        return;
      }
      if (err.type === 'peer-unavailable') {
        teardown();
        showJoin(`No game found with code ${code}. Check the code and that the host has started hosting.`, true);
      } else if (!conn || !conn.open) {
        teardown();
        showJoin('Could not connect: ' + (err.message || err.type), true);
      }
    });
    peer.on('disconnected', () => {
      if (peer && !peer.destroyed && conn && conn.open) peer.reconnect();
    });
  }

  function onHostData(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        setRole(msg.role);
        hostHidden = !!msg.hostHidden;
        refreshOverlay();
        break;
      case 'role':
        releaseAll();
        setRole(msg.role);
        break;
      case 'hostHidden':
        hostHidden = !!msg.v;
        refreshOverlay();
        break;
      case 'pong':
        rtt = performance.now() - msg.ts;
        lastPong = performance.now();
        break;
      case 'full':
        if (reconnect) { retrySoon(); break; }
        teardown();
        showJoin('That game already has two players.', true);
        break;
      case 'bye':
        hostSaidBye = true;
        break;
      case 'error':
        setVideoStatus('The host could not start the video: ' + msg.message);
        break;
      case 'hostVideo':
        if (!gotVideo && msg.s === 'failed') setVideoStatus(ICE_TEXT.failed);
        break;
    }
  }

  // ---------- getting back in after a dropped connection ----------
  function connectionLost() {
    if (!conn) return;
    teardown();
    showScreen();
    if (hostSaidBye) {
      els.info.hidden = true;
      setOverlay('The host ended the game.', true);
      return;
    }
    reconnect = { until: Date.now() + RECONNECT_FOR_MS, attempt: 0, timer: null };
    retrySoon(0);
  }

  function retrySoon(delay = 2000) {
    if (!reconnect) return;
    teardown();
    clearTimeout(reconnect.timer);
    if (Date.now() > reconnect.until) {
      stopReconnecting();
      els.info.hidden = true;
      setOverlay('Could not reconnect to the host. They may have closed the game.', true, true);
      return;
    }
    setOverlay(`Connection lost. Reconnecting… (attempt ${reconnect.attempt + 1})`);
    reconnect.timer = setTimeout(() => {
      if (!reconnect) return;
      reconnect.attempt++;
      join(currentCode, true);
    }, delay);
  }

  function stopReconnecting() {
    if (reconnect) clearTimeout(reconnect.timer);
    reconnect = null;
  }

  function teardown() {
    clearTimeout(connectTimer);
    timers.forEach(clearInterval);
    timers = [];
    pressed.clear();
    padState = {};
    lastSent = '';
    gotVideo = false;
    videoStatus = 'Waiting for the host to send the video…';
    hostHidden = false;
    rtt = null;
    const c = conn;
    conn = null;
    if (c) { try { c.close(); } catch {} }
    if (fast) { try { fast.close(); } catch {} }
    fast = null;
    lastJb = null;
    if (mediaCall) { try { mediaCall.close(); } catch {} }
    mediaCall = null;
    if (peer) { try { peer.destroy(); } catch {} }
    peer = null;
    els.video.srcObject = null;
    els.stats.textContent = '';
    els.unmuteBtn.hidden = true;
  }

  function leave() {
    stopReconnecting();
    teardown();
    history.replaceState(null, '', location.pathname);
    document.title = 'Fireboy & Watergirl Online';
    showJoin();
  }

  function send(msg) {
    if (conn && conn.open) conn.send(msg);
  }

  // Keys and pings go over the unordered channel when it's up, else the main one.
  function sendFast(msg) {
    if (fast && fast.open) fast.send(msg);
    else send(msg);
  }

  function openFastChannel(code) {
    if (!peer || peer.destroyed) return;
    const c = peer.connect(peerIdFor(code), { reliable: false, serialization: 'json', metadata: { kind: 'fast' } });
    fast = c;
    c.on('data', onHostData);
    const gone = () => { if (fast === c) fast = null; };
    c.on('close', gone);
    c.on('error', gone);
  }

  function startTimers() {
    lastPong = performance.now();
    timers.push(setInterval(() => {
      if (performance.now() - lastPong > settings.hostTimeoutMs) {
        connectionLost();
        return;
      }
      sendFast({ t: 'ping', ts: performance.now(), rtt });
    }, 1000));
    // Resend the full key state so a lost message can't leave a key stuck: every
    // 100 ms while keys are held or just changed, otherwise twice a second.
    timers.push(setInterval(() => {
      const now = performance.now();
      if (lastSent.includes('1') || now - lastKeyChange < 600 || now - lastKeySend >= 500) sendKeys(true);
    }, 100));
    timers.push(setInterval(updateStats, 1000));
    timers.push(setInterval(pollPad, 16));
  }

  function pollPad() {
    const next = FBWG.readGamepads(controls.gamepad);
    if (DIRECTIONS.some((d) => !!next[d] !== !!padState[d])) {
      padState = next;
      sendKeys();
    }
  }

  // ---------- video ----------
  function tuneReceivers(pc) {
    if (!pc) return;
    for (const r of pc.getReceivers()) {
      if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
      else if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
    }
  }

  async function playVideo() {
    const v = els.video;
    v.muted = false;
    try {
      await v.play();
      els.unmuteBtn.hidden = true;
    } catch {
      // Autoplay with sound needs a click on this page first.
      v.muted = true;
      els.unmuteBtn.hidden = !hasAudio();
      try { await v.play(); } catch {}
    }
    updateSoundBtn();
  }

  function hasAudio() {
    const s = els.video.srcObject;
    return !!(s && s.getAudioTracks().length);
  }

  function updateSoundBtn() {
    els.soundBtn.textContent = els.video.muted ? 'Sound off' : 'Sound on';
    els.soundBtn.disabled = !hasAudio();
    els.soundBtn.title = hasAudio() ? 'Sound (M)' : 'No sound from the host yet';
  }

  function toggleSound(force) {
    els.video.muted = typeof force === 'boolean' ? !force : !els.video.muted;
    els.unmuteBtn.hidden = true;
    els.video.play().catch(() => {});
    updateSoundBtn();
  }

  els.video.addEventListener('loadeddata', () => { gotVideo = true; refreshOverlay(); updateSoundBtn(); });
  els.video.addEventListener('resize', () => { gotVideo = true; refreshOverlay(); });

  async function updateStats() {
    let fps = null;
    let buffer = null;
    let path = null;
    const pc = mediaCall && mediaCall.peerConnection;
    if (pc) {
      try {
        const report = await pc.getStats();
        let pairId = null;
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            if (s.framesPerSecond != null) fps = s.framesPerSecond;
            // Average time frames waited in the jitter buffer over the last second.
            if (s.jitterBufferEmittedCount != null) {
              if (lastJb && s.jitterBufferEmittedCount > lastJb.n) {
                buffer = ((s.jitterBufferDelay - lastJb.d) / (s.jitterBufferEmittedCount - lastJb.n)) * 1000;
              }
              lastJb = { d: s.jitterBufferDelay, n: s.jitterBufferEmittedCount };
            }
          }
          if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
        });
        const pair = pairId && report.get(pairId);
        if (pair) {
          const types = [report.get(pair.localCandidateId), report.get(pair.remoteCandidateId)].map((c) => c && c.candidateType);
          path = types.includes('relay') ? 'relayed' : 'direct';
        }
      } catch {}
    }
    const parts = [];
    if (fps != null) parts.push(`${Math.round(fps)} fps`);
    if (rtt != null) parts.push(`${Math.round(rtt)} ms ping`);
    if (buffer != null) parts.push(`${Math.round(buffer)} ms buffer`);
    if (path) parts.push(path);
    els.stats.textContent = parts.join(' · ');
  }

  // ---------- input ----------
  function keyState() {
    const k = {};
    for (const code of pressed) {
      const d = dirFor(code);
      if (d) k[d] = true;
    }
    for (const d of DIRECTIONS) if (padState[d]) k[d] = true;
    return k;
  }

  function sendKeys(force = false) {
    const k = keyState();
    const sig = DIRECTIONS.map((d) => (k[d] ? 1 : 0)).join('');
    if (!force && sig === lastSent) return;
    const now = performance.now();
    if (sig !== lastSent) lastKeyChange = now;
    lastSent = sig;
    lastKeySend = now;
    sendFast({ t: 'keys', k, seq: ++keySeq });
  }

  function releaseAll() {
    pressed.clear();
    sendKeys(true);
  }

  function typingInField(e) {
    return e.target instanceof HTMLInputElement;
  }

  window.addEventListener('keydown', (e) => {
    if (typingInField(e) || !conn) return;
    if (ALL_MOVE_CODES.has(e.code)) {
      e.preventDefault();
      if (e.repeat) return;
      pressed.add(e.code);
      sendKeys();
    } else if (e.code === 'KeyF' && !e.repeat) {
      toggleFullscreen();
    } else if (e.code === 'KeyM' && !e.repeat) {
      toggleSound();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (!ALL_MOVE_CODES.has(e.code)) return;
    pressed.delete(e.code);
    if (conn) sendKeys();
  });

  window.addEventListener('blur', () => { if (conn) releaseAll(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && conn) releaseAll(); });

  // Map a point on the <video> element to 0..1 inside the letterboxed picture.
  // Works for every picture size: fit (bars), zoom (edges cut off) and stretch.
  function videoPoint(e) {
    const v = els.video;
    const r = v.getBoundingClientRect();
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return null;
    let w = r.width;
    let h = r.height;
    if (fitMode !== 'stretch') {
      const scale = (fitMode === 'zoom' ? Math.max : Math.min)(r.width / vw, r.height / vh);
      w = vw * scale;
      h = vh * scale;
    }
    const x = (e.clientX - r.left - (r.width - w) / 2) / w;
    const y = (e.clientY - r.top - (r.height - h) / 2) / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  let lastMove = 0;
  els.video.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 33) return;
    lastMove = now;
    const p = videoPoint(e);
    if (p) send({ t: 'mouse', type: 'mousemove', ...p });
  });
  els.video.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (els.video.muted && hasAudio()) toggleSound(true);
    const p = videoPoint(e);
    if (p) send({ t: 'mouse', type: 'mousedown', ...p });
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !conn) return;
    const p = videoPoint(e) || { x: 0, y: 0 };
    send({ t: 'mouse', type: 'mouseup', ...p });
  });

  // ---------- buttons ----------
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else els.screen.requestFullscreen().catch(() => {});
  }

  // ---------- picture size ----------
  const FIT_MODES = ['fit', 'stretch', 'zoom'];
  const FIT_LABELS = { fit: 'Fit', stretch: 'Stretch', zoom: 'Zoom' };
  const FIT_TITLES = {
    fit: 'Whole picture, correct shape (black bars). Click for Stretch.',
    stretch: 'Fills the window; the picture gets wider. Click for Zoom.',
    zoom: 'Fills the window, correct shape; edges are cut off. Click for Fit.',
  };
  let fitMode = 'fit';
  try { if (FIT_MODES.includes(localStorage.getItem('fbwg-fit'))) fitMode = localStorage.getItem('fbwg-fit'); } catch {}

  function applyFit() {
    for (const m of FIT_MODES) els.screen.classList.toggle('fit-' + m, m === fitMode);
    els.fitBtn.textContent = FIT_LABELS[fitMode];
    els.fitBtn.title = FIT_TITLES[fitMode];
  }

  els.fitBtn.addEventListener('click', () => {
    fitMode = FIT_MODES[(FIT_MODES.indexOf(fitMode) + 1) % FIT_MODES.length];
    try { localStorage.setItem('fbwg-fit', fitMode); } catch {}
    applyFit();
  });
  applyFit();

  els.fullBtn.addEventListener('click', toggleFullscreen);
  els.soundBtn.addEventListener('click', () => toggleSound());
  els.unmuteBtn.addEventListener('click', () => toggleSound(true));
  els.leaveBtn.addEventListener('click', leave);
  els.controlsBtn.addEventListener('click', () => {
    chrome.windows.create({ url: chrome.runtime.getURL('controls.html'), type: 'popup', width: 560, height: 760, focused: true });
  });
  els.codeInput.addEventListener('input', () => {
    els.codeInput.value = normalizeCode(els.codeInput.value);
  });
  els.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    join(els.codeInput.value);
  });
  window.addEventListener('pagehide', teardown);

  const initial = normalizeCode(new URLSearchParams(location.search).get('code'));
  if (initial) {
    els.codeInput.value = initial;
    join(initial);
  } else {
    showJoin();
  }
})();
