// Guest side: shows the host's game stream and sends this player's input back.
(() => {
  const { DIRECTIONS, ROLE_NAMES, normalizeCode, peerIdFor, CODE_LENGTH } = FBWG;
  const $ = (id) => document.getElementById(id);

  const els = {
    joinCard: $('joinCard'), joinForm: $('joinForm'), codeInput: $('codeInput'), joinBtn: $('joinBtn'),
    joinMsg: $('joinMsg'), screen: $('screen'), video: $('video'), overlay: $('overlay'),
    info: $('info'), roleChip: $('roleChip'), hint: $('hint'), stats: $('stats'),
    actions: $('actions'), soundBtn: $('soundBtn'), fullBtn: $('fullBtn'), leaveBtn: $('leaveBtn'),
    unmuteBtn: $('unmuteBtn'),
  };

  const KEY_TO_DIR = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowDown: 'down', KeyS: 'down',
  };

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

  function setOverlay(text, withRetry = false) {
    els.overlay.textContent = '';
    if (!text) return;
    const wrap = document.createElement('div');
    wrap.textContent = text;
    if (withRetry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Back to join screen';
      b.addEventListener('click', () => leave());
      wrap.append(document.createElement('br'), b);
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
    els.hint.textContent = 'Move with arrow keys or W A D · click the game to use menus';
    document.title = `${ROLE_NAMES[r]} · Fireboy & Watergirl Online`;
  }

  // ---------- connection ----------
  function join(code) {
    code = normalizeCode(code);
    if (code.length !== CODE_LENGTH) {
      showJoin(`Room codes are ${CODE_LENGTH} characters.`, true);
      return;
    }
    teardown();
    history.replaceState(null, '', '?code=' + code);
    els.joinBtn.disabled = true;
    els.joinMsg.classList.remove('bad');
    els.joinMsg.textContent = 'Connecting…';

    peer = new Peer(FBWG.peerOptions(settings));
    peer.on('open', () => {
      conn = peer.connect(peerIdFor(code), { reliable: true, serialization: 'json' });
      conn.on('open', () => {
        showScreen();
        refreshOverlay();
        startTimers();
      });
      conn.on('data', onHostData);
      conn.on('close', () => hostGone('The host ended the game or closed the tab.'));
      conn.on('error', () => hostGone('The connection to the host was lost.'));
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
        teardown();
        showJoin('That game already has two players.', true);
        break;
      case 'error':
        setVideoStatus('The host could not start the video: ' + msg.message);
        break;
      case 'hostVideo':
        if (!gotVideo && msg.s === 'failed') setVideoStatus(ICE_TEXT.failed);
        break;
    }
  }

  function hostGone(text) {
    if (!conn) return;
    teardown();
    showScreen();
    els.info.hidden = true;
    setOverlay(text, true);
  }

  function teardown() {
    timers.forEach(clearInterval);
    timers = [];
    pressed.clear();
    lastSent = '';
    gotVideo = false;
    videoStatus = 'Waiting for the host to send the video…';
    hostHidden = false;
    rtt = null;
    const c = conn;
    conn = null;
    if (c) { try { c.close(); } catch {} }
    if (mediaCall) { try { mediaCall.close(); } catch {} }
    mediaCall = null;
    if (peer) { try { peer.destroy(); } catch {} }
    peer = null;
    els.video.srcObject = null;
    els.stats.textContent = '';
    els.unmuteBtn.hidden = true;
  }

  function leave() {
    teardown();
    history.replaceState(null, '', location.pathname);
    document.title = 'Fireboy & Watergirl Online';
    showJoin();
  }

  function send(msg) {
    if (conn && conn.open) conn.send(msg);
  }

  function startTimers() {
    lastPong = performance.now();
    timers.push(setInterval(() => {
      if (performance.now() - lastPong > settings.hostTimeoutMs) {
        hostGone('Lost the connection to the host.');
        return;
      }
      send({ t: 'ping', ts: performance.now(), rtt });
    }, 1000));
    // Resend the full key state regularly so a lost/late message can't leave a key stuck.
    timers.push(setInterval(() => sendKeys(true), 300));
    timers.push(setInterval(updateStats, 1000));
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
    const pc = mediaCall && mediaCall.peerConnection;
    if (pc) {
      try {
        const report = await pc.getStats();
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video' && s.framesPerSecond != null) fps = s.framesPerSecond;
        });
      } catch {}
    }
    const parts = [];
    if (fps != null) parts.push(`${Math.round(fps)} fps`);
    if (rtt != null) parts.push(`${Math.round(rtt)} ms ping`);
    els.stats.textContent = parts.join(' · ');
  }

  // ---------- input ----------
  function keyState() {
    const k = {};
    for (const code of pressed) k[KEY_TO_DIR[code]] = true;
    return k;
  }

  function sendKeys(force = false) {
    const k = keyState();
    const sig = DIRECTIONS.map((d) => (k[d] ? 1 : 0)).join('');
    if (!force && sig === lastSent) return;
    lastSent = sig;
    send({ t: 'keys', k });
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
    if (KEY_TO_DIR[e.code]) {
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
    if (!KEY_TO_DIR[e.code]) return;
    pressed.delete(e.code);
    if (conn) sendKeys();
  });

  window.addEventListener('blur', () => { if (conn) releaseAll(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && conn) releaseAll(); });

  // Map a point on the <video> element to 0..1 inside the letterboxed picture.
  function videoPoint(e) {
    const v = els.video;
    const r = v.getBoundingClientRect();
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale;
    const h = vh * scale;
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

  els.fullBtn.addEventListener('click', toggleFullscreen);
  els.soundBtn.addEventListener('click', () => toggleSound());
  els.unmuteBtn.addEventListener('click', () => toggleSound(true));
  els.leaveBtn.addEventListener('click', leave);
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
