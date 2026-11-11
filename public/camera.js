'use strict';

// Dual camera: one photo from the back camera with the front camera inset,
// sent as a single JPEG. Phones that can run both cameras at once (many
// Androids) capture both in the same instant. The rest (iPhone, most
// browsers) capture the main camera, switch, and capture the other one a
// moment later. Devices with one camera send a normal photo.
//
// Loaded on demand by app.js: window.WalkiCamera.open({ onSend, toast }).

(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('camera');
  const mainV = $('camMain');
  const insetV = $('camInset');
  const frozen = $('camFrozen');
  const shot = $('camShot');
  const hint = $('camHint');
  const shutter = $('camShutter');
  const swapBtn = $('camSwap');
  const closeBtn = $('camClose');
  const retakeBtn = $('camRetake');
  const sendBtn = $('camSend');
  const flashEl = $('camFlash');

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const MAX_SIDE = 1600;
  const MAX_BYTES = 900_000;

  let streams = { environment: null, user: null };
  let roles = { main: 'environment', inset: 'user' };
  let multi = true; // the device has front and back cameras
  let together = false; // both can run at the same time
  let token = 0; // bumps on every (re)start and close, cancelling stale work
  let busy = false;
  let result = null;
  let resultUrl = '';
  let opts = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pref = {
    get: () => { try { return localStorage.getItem('walki:dualcam'); } catch { return null; } },
    set: (v) => { try { localStorage.setItem('walki:dualcam', v); } catch {} },
  };

  const constraints = (facing) => ({
    audio: false,
    video: { facingMode: { exact: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
  });

  function stop(s) {
    if (s) s.getTracks().forEach((t) => t.stop());
  }
  function stopAll() {
    stop(streams.environment);
    stop(streams.user);
    streams = { environment: null, user: null };
    mainV.srcObject = null;
    insetV.srcObject = null;
  }

  function setMode(mode) {
    root.dataset.mode = mode; // loading | capture | review
    shutter.disabled = mode !== 'capture';
  }

  function say(text) {
    hint.textContent = text || '';
    hint.classList.toggle('show', !!text);
  }

  async function attach(video, stream, facing) {
    video.srcObject = stream;
    video.classList.toggle('mirror', facing === 'user');
    try { await video.play(); } catch {}
    if (!video.videoWidth) {
      await new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener('loadeddata', done, { once: true });
        setTimeout(done, 2500);
      });
    }
  }

  const live = (s) => s && s.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);

  async function start() {
    const my = ++token;
    stopAll();
    setMode('loading');
    say('');
    frozen.hidden = true;
    let main;
    try {
      main = await navigator.mediaDevices.getUserMedia(constraints(roles.main));
    } catch (err) {
      if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError' && err.name !== 'NotReadableError') throw err;
      // A laptop or a phone with one camera: any camera will do.
      main = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1440 } } });
      multi = false;
    }
    if (my !== token) return stop(main);
    streams[roles.main] = main;
    together = false;

    // Try both cameras at once unless this device is known not to manage it.
    if (multi && !isIOS && pref.get() !== '0') {
      try {
        const second = await navigator.mediaDevices.getUserMedia(constraints(roles.inset));
        if (my !== token) return stop(second);
        await sleep(350);
        if (live(main) && live(second)) {
          streams[roles.inset] = second;
          together = true;
          pref.set('1');
        } else {
          stop(second);
          pref.set('0');
        }
      } catch {
        pref.set('0');
      }
      if (!together && !live(main)) {
        // Opening the second camera stopped the first; open it again.
        stop(main);
        main = await navigator.mediaDevices.getUserMedia(constraints(roles.main));
        if (my !== token) return stop(main);
        streams[roles.main] = main;
      }
    }

    await attach(mainV, main, multi ? roles.main : 'environment');
    if (together) await attach(insetV, streams[roles.inset], roles.inset);
    if (my !== token) return;
    root.classList.toggle('single', !multi);
    root.classList.toggle('together', together);
    swapBtn.hidden = !multi;
    root.querySelector('.cam-title').textContent = multi ? 'Dual photo' : 'Photo';
    setMode('capture');
  }

  function grab(video, facing) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error('camera not ready');
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const g = c.getContext('2d');
    if (facing === 'user') {
      // Selfies look the way they did on screen.
      g.translate(c.width, 0);
      g.scale(-1, 1);
    }
    g.drawImage(video, 0, 0, c.width, c.height);
    return c;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function compose(main, inset) {
    const W = main.width;
    const H = main.height;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.drawImage(main, 0, 0);
    if (inset) {
      const iw = Math.round(W * (W > H ? 0.24 : 0.32));
      const ih = Math.round((iw * inset.height) / inset.width);
      const m = Math.round(Math.min(W, H) * 0.04);
      const r = Math.round(iw * 0.12);
      const line = Math.max(3, Math.round(W * 0.006));
      g.save();
      g.shadowColor = 'rgba(0,0,0,.45)';
      g.shadowBlur = line * 4;
      roundRect(g, m, m, iw, ih, r);
      g.fillStyle = '#000';
      g.fill();
      g.restore();
      g.save();
      roundRect(g, m, m, iw, ih, r);
      g.clip();
      g.drawImage(inset, m, m, iw, ih);
      g.restore();
      roundRect(g, m, m, iw, ih, r);
      g.lineWidth = line;
      g.strokeStyle = '#000';
      g.stroke();
    }
    return c;
  }

  const toBlob = (c, q) => new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', q));

  async function encode(c) {
    for (const q of [0.85, 0.75, 0.65, 0.55]) {
      const b = await toBlob(c, q);
      if (b && b.size <= MAX_BYTES) return b;
    }
    // Still too big (very detailed scene): halve the size.
    const half = document.createElement('canvas');
    half.width = Math.round(c.width / 2);
    half.height = Math.round(c.height / 2);
    half.getContext('2d').drawImage(c, 0, 0, half.width, half.height);
    return toBlob(half, 0.7);
  }

  function flash() {
    flashEl.classList.remove('go');
    void flashEl.offsetWidth;
    flashEl.classList.add('go');
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function showFrozen(canvas) {
    frozen.width = canvas.width;
    frozen.height = canvas.height;
    frozen.getContext('2d').drawImage(canvas, 0, 0);
    frozen.hidden = false;
  }

  async function capture() {
    if (busy || root.dataset.mode !== 'capture') return;
    busy = true;
    const my = token;
    setMode('loading');
    try {
      let main;
      let inset = null;
      if (!multi) {
        main = grab(mainV, 'environment');
        flash();
      } else if (together) {
        main = grab(mainV, roles.main);
        inset = grab(insetV, roles.inset);
        flash();
      } else {
        main = grab(mainV, roles.main);
        flash();
        showFrozen(main);
        stop(streams[roles.main]);
        streams[roles.main] = null;
        say(roles.inset === 'user' ? 'Now smile…' : 'Now the back camera…');
        const s = await navigator.mediaDevices.getUserMedia(constraints(roles.inset));
        if (my !== token) return stop(s);
        streams[roles.inset] = s;
        await attach(insetV, s, roles.inset);
        root.classList.add('together'); // show the inset live while it settles
        await sleep(900); // let exposure and focus settle
        if (my !== token) return;
        inset = grab(insetV, roles.inset);
        flash();
        say('');
      }
      stopAll();
      const blob = await encode(compose(main, inset));
      if (my !== token) return;
      result = blob;
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      shot.src = resultUrl;
      setMode('review');
    } catch (err) {
      console.warn('camera', err);
      if (my === token) {
        opts.toast('Couldn’t take the photo, try again');
        start().catch(fail);
      }
    } finally {
      busy = false;
    }
  }

  function fail(err) {
    console.warn('camera', err);
    const name = err && err.name;
    opts.toast(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Allow camera access to send photos'
        : name === 'NotFoundError' ? 'No camera found' : 'Couldn’t start the camera'
    );
    close();
  }

  function close() {
    token++;
    busy = false;
    stopAll();
    result = null;
    shot.removeAttribute('src');
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = '';
    root.hidden = true;
    root.classList.remove('open');
    say('');
    if (opts && opts.onClose) opts.onClose();
  }

  async function swap() {
    if (busy || !multi || root.dataset.mode !== 'capture') return;
    roles = { main: roles.inset, inset: roles.main };
    if (together) {
      // Both are running: just trade places.
      const a = streams[roles.main];
      const b = streams[roles.inset];
      await attach(mainV, a, roles.main);
      await attach(insetV, b, roles.inset);
    } else {
      start().catch(fail);
    }
  }

  shutter.addEventListener('click', capture);
  swapBtn.addEventListener('click', swap);
  closeBtn.addEventListener('click', close);
  retakeBtn.addEventListener('click', () => start().catch(fail));
  sendBtn.addEventListener('click', () => {
    if (!result) return;
    const blob = result;
    result = null;
    opts.onSend(blob);
    close();
  });
  window.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    if (e.key === 'Escape') close();
    else if ((e.code === 'Space' || e.key === 'Enter') && root.dataset.mode === 'capture') {
      e.preventDefault();
      capture();
    }
  });
  // Never keep the camera running in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !root.hidden) close();
  });

  window.WalkiCamera = {
    open(o) {
      opts = o;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return o.toast('Open walki over HTTPS to use the camera');
      }
      root.hidden = false;
      requestAnimationFrame(() => root.classList.add('open'));
      start().catch(fail);
    },
    close,
  };
})();
