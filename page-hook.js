// Runs in the game page's own JavaScript world (not the extension's isolated world),
// at document_start, so it is set up before the game registers its listeners.
// The isolated-world host script talks to it through CustomEvents on `document`.
(() => {
  if (window.__fbwgHook) return;
  window.__fbwgHook = true;

  // --- Remote key injection ---------------------------------------------------
  // The game reads `keyCode`, which the KeyboardEvent constructor cannot set,
  // so it is defined on the instance. Dispatching on `document` reaches both the
  // game's document and window listeners.
  document.addEventListener('fbwg-key', (e) => {
    let d;
    try { d = JSON.parse(e.detail); } catch { return; }
    const ev = new KeyboardEvent(d.type, { key: d.key, code: d.code, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => d.keyCode });
    Object.defineProperty(ev, 'which', { get: () => d.keyCode });
    ev.__fbwgRemote = true;
    document.dispatchEvent(ev);
  });

  // --- Lock the guest's character on the host keyboard ------------------------
  // Real (trusted) key presses for the guest's keys are swallowed before the game
  // sees them, so the host can't accidentally move their friend's character.
  let blocked = new Set();
  document.addEventListener('fbwg-lock', (e) => {
    try { blocked = new Set(JSON.parse(e.detail)); } catch { blocked = new Set(); }
  });
  const guard = (e) => {
    if (e.isTrusted && blocked.has(e.keyCode)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', guard, true);
  window.addEventListener('keyup', guard, true);

  // --- Keep running in the background while hosting -------------------------
  // Chrome stops requestAnimationFrame in hidden tabs, which freezes the game
  // (and the stream) whenever the host switches tabs or minimizes. While hosting,
  // frame requests made in a hidden tab are driven by a worker timer instead;
  // worker timers are not throttled in background tabs.
  const origRAF = window.requestAnimationFrame.bind(window);
  const origCAF = window.cancelAnimationFrame.bind(window);
  const pending = new Map(); // id -> { cb, raf }
  let nextId = 1;
  let background = false;
  let ticker = null;

  const useTicker = () => background && document.hidden;

  function schedule(id, entry) {
    entry.raf = useTicker() ? null : origRAF((ts) => { pending.delete(id); entry.cb(ts); });
  }

  window.requestAnimationFrame = function (cb) {
    const id = nextId++;
    const entry = { cb, raf: null };
    pending.set(id, entry);
    schedule(id, entry);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    const entry = pending.get(id);
    if (!entry) return;
    if (entry.raf != null) origCAF(entry.raf);
    pending.delete(id);
  };

  function tick() {
    if (!useTicker()) return;
    const now = performance.now();
    const due = [...pending.entries()].filter(([, e]) => e.raf == null);
    for (const [id, e] of due) {
      pending.delete(id);
      try { e.cb(now); } catch (err) { console.error(err); }
    }
  }

  // Move waiting callbacks between the real rAF and the ticker when visibility changes.
  function reschedule() {
    for (const [id, e] of pending) {
      if (e.raf != null) origCAF(e.raf);
      schedule(id, e);
    }
  }
  document.addEventListener('visibilitychange', reschedule);

  document.addEventListener('fbwg-background', (e) => {
    background = e.detail === 'on';
    if (background && !ticker) {
      const src = 'let t;onmessage=e=>{clearInterval(t);if(e.data)t=setInterval(()=>postMessage(0),e.data)}';
      ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      ticker.onmessage = tick;
      ticker.postMessage(1000 / 60);
    } else if (!background && ticker) {
      ticker.terminate();
      ticker = null;
    }
    reschedule();
  });

  // --- Audio tap ------------------------------------------------------------
  // The game plays sound through Web Audio (`node.connect(ctx.destination)`).
  // Every connection to a destination is mirrored into a MediaStream destination,
  // exposed through a silent <audio> element so the isolated world can pick up
  // the stream (both worlds share the same DOM element).
  const TAP_ID = 'fbwg-audio-tap';
  const taps = new WeakMap();
  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;

  function tapFor(ctx) {
    let tap = taps.get(ctx);
    if (tap || typeof ctx.createMediaStreamDestination !== 'function') return tap;
    tap = ctx.createMediaStreamDestination();
    taps.set(ctx, tap);
    let el = document.getElementById(TAP_ID);
    if (!el) {
      el = document.createElement('audio');
      el.id = TAP_ID;
      el.hidden = true;
      (document.body || document.documentElement).appendChild(el);
    }
    el.srcObject = tap.stream;
    document.dispatchEvent(new CustomEvent('fbwg-audio-ready'));
    return tap;
  }

  AudioNode.prototype.connect = function (dest, ...rest) {
    const result = origConnect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      try {
        const tap = tapFor(dest.context);
        if (tap) origConnect.call(this, tap);
      } catch {}
    }
    return result;
  };

  AudioNode.prototype.disconnect = function (...args) {
    const dest = args[0];
    if (dest instanceof AudioDestinationNode) {
      const tap = taps.get(dest.context);
      if (tap) {
        try { origDisconnect.call(this, tap); } catch {}
      }
    }
    return origDisconnect.apply(this, args);
  };
})();
