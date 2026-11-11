'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const els = {
    joinForm: $('joinForm'),
    nameInput: $('nameInput'),
    channelInput: $('channelInput'),
    joinBtn: $('joinBtn'),
    joinError: $('joinError'),
    leaveBtn: $('leaveBtn'),
    menuBtn: $('menuBtn'),
    channelName: $('channelName'),
    statusText: $('statusText'),
    notice: $('notice'),
    noticeMain: $('noticeMain'),
    noticeText: $('noticeText'),
    noticeAct: $('noticeAct'),
    noticeClose: $('noticeClose'),
    pttWrap: $('pttWrap'),
    ptt: $('ptt'),
    caption: document.querySelector('.caption'),
    captionMain: $('captionMain'),
    captionSub: $('captionSub'),
    historyBtn: $('historyBtn'),
    historyBadge: $('historyBadge'),
    cameraBtn: $('cameraBtn'),
    members: $('members'),
    inviteChip: $('inviteChip'),
    photoCard: $('photoCard'),
    photoCardImg: $('photoCardImg'),
    photoCardName: $('photoCardName'),
    scrim: $('scrim'),
    historySheet: $('historySheet'),
    historyList: $('historyList'),
    playMissedBtn: $('playMissedBtn'),
    menuSheet: $('menuSheet'),
    menuTitle: $('menuTitle'),
    inviteRow: $('inviteRow'),
    alertsToggle: $('alertsToggle'),
    alertsSub: $('alertsSub'),
    awakeToggle: $('awakeToggle'),
    installRow: $('installRow'),
    installSub: $('installSub'),
    clearRow: $('clearRow'),
    storageSub: $('storageSub'),
    leaveRow: $('leaveRow'),
    camera: $('camera'),
    viewer: $('viewer'),
    viewerImg: $('viewerImg'),
    viewerName: $('viewerName'),
    viewerTime: $('viewerTime'),
    viewerClose: $('viewerClose'),
    viewerSave: $('viewerSave'),
    toast: $('toast'),
    haptic: $('haptic'),
  };

  // How often the app checks the channel. On screen it polls (fast while
  // people talk, slower when quiet). In the background it stops after a short
  // grace period and lets Web Push wake the phone, which costs no battery.
  const POLL_ACTIVE_MS = 1500;
  const POLL_QUIET_MS = 3000;
  const POLL_IDLE_MS = 5000;
  const POLL_HIDDEN_MS = 6000;
  const ACTIVE_WINDOW_MS = 20_000;
  const IDLE_AFTER_MS = 5 * 60_000;
  const BG_GRACE_PUSH_MS = 2 * 60_000; // alerts on: they take over quickly
  const BG_GRACE_MS = 15 * 60_000; // alerts off: keep listening a while
  const MAX_TALK_MS = 60_000;
  const MIN_CLIP_MS = 350; // shorter presses are treated as accidental
  const CLIP_RATE = 8000; // clips are 8 kHz mu-law, ~8 KB per second of speech
  const MIC_IDLE_MS = 4000; // keep the mic warm briefly for quick replies
  const HIST_DAYS = 7;
  const HIST_MAX = 200;
  const MEDIA_CACHE = 'walki-media';

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const visible = () => document.visibilityState === 'visible';

  const S = {
    myId: '',
    name: '',
    channel: '',
    joined: false,
    session: 0, // bumps on join / leave so stale async work is ignored
    connected: false,
    failures: 0,
    syncing: false, // next poll is a catch-up: new clips count as missed
    since: 0,
    pollTimer: 0,
    polling: false,
    pollAgain: false,
    sleeping: false,
    hiddenAt: 0,
    lastActivity: 0,
    members: new Map(), // id -> { id, name, v }
    away: new Map(), // id -> name (alerts on, app closed)
    talker: null,
    queue: [], // { item, manual, data }
    playing: null,
    sending: 0,
    // push-to-talk
    held: false,
    pressing: false,
    flow: false,
    finishing: false,
    again: false,
    recording: false,
    floorQ: Promise.resolve(),
    tx: false,
    txStart: 0,
    txTimer: 0,
    state: 'idle',
    // audio
    ctx: null,
    stream: null,
    track: null,
    mic: null,
    micP: null,
    micIdle: 0,
    recReady: null,
    chunks: [],
    recDone: null,
    micAnalyser: null,
    rxAnalyser: null,
    level: 0,
    levelBuf: new Float32Array(512),
    raf: 0,
    wakeLock: null,
    pendingOpen: '',
    installEvt: null,
    pushOn: false,
    pushSynced: '',
    openSheet: null,
  };

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
    keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
  };

  const normalizeChannel = (s) =>
    String(s || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24);

  const initials = (name) => {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    const chars = parts.length > 1 ? [Array.from(parts[0])[0], Array.from(parts[1])[0]] : [Array.from(parts[0] || '?')[0]];
    return chars.join('').toUpperCase();
  };

  const newId = () =>
    crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  const fmtTime = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function fmtDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  let toastTimer = 0;
  function toast(text, ms = 2400) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
  }

  function haptic(pattern = 12) {
    if (navigator.vibrate) navigator.vibrate(pattern);
    else els.haptic.click(); // iOS 18+: toggling a switch input gives a light tap
  }

  // A device keeps one id, so background alerts find it again after a restart.
  function deviceId() {
    let id = store.get('walki:id');
    if (!/^[a-z0-9-]{8,40}$/i.test(id)) {
      id = newId();
      store.set('walki:id', id);
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // History: message list in localStorage, audio/photos in Cache Storage.
  // Pruned to 7 days / 200 messages per channel.
  // -------------------------------------------------------------------------
  const clipUrl = (c, k) => `/api/clip?${new URLSearchParams({ c, k })}`;
  const histKey = (c) => `walki:h:${c}`;

  const H = {
    c: '',
    items: [], // oldest first
    byK: new Map(),
    saveTimer: 0,
    load(c) {
      this.flush();
      this.c = c;
      let arr = [];
      try { arr = JSON.parse(store.get(histKey(c)) || '[]'); } catch {}
      this.items = Array.isArray(arr) ? arr.filter((i) => i && i.k) : [];
      this.byK = new Map(this.items.map((i) => [i.k, i]));
    },
    add(item) {
      const had = this.byK.get(item.k);
      if (had) return had;
      this.byK.set(item.k, item);
      let i = this.items.length;
      while (i > 0 && this.items[i - 1].ts > item.ts) i--;
      this.items.splice(i, 0, item);
      if (this.items.length > HIST_MAX) {
        const drop = this.items.splice(0, this.items.length - HIST_MAX);
        drop.forEach((d) => this.byK.delete(d.k));
        dropMedia(this.c, drop.map((d) => d.k));
      }
      this.save();
      return item;
    },
    save() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flush(), 300);
    },
    flush() {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      if (!this.c) return;
      if (!store.set(histKey(this.c), JSON.stringify(this.items))) {
        // Storage full: keep the newest half.
        const drop = this.items.splice(0, Math.ceil(this.items.length / 2));
        drop.forEach((d) => this.byK.delete(d.k));
        dropMedia(this.c, drop.map((d) => d.k));
        store.set(histKey(this.c), JSON.stringify(this.items));
      }
    },
    unread() {
      let n = 0;
      for (const i of this.items) if (i.u) n++;
      return n;
    },
    clear() {
      dropMedia(this.c, this.items.map((i) => i.k));
      this.items = [];
      this.byK.clear();
      this.flush();
    },
  };

  // Drops expired history in every channel and anything cached without a
  // history entry. Runs once per launch, after the first sync.
  async function sweep() {
    const cutoff = Date.now() - HIST_DAYS * 86400_000;
    const keep = new Set();
    for (const key of store.keys()) {
      if (!key.startsWith('walki:h:')) continue;
      const c = key.slice(8);
      let items = [];
      try { items = c === H.c ? H.items : JSON.parse(store.get(key) || '[]'); } catch {}
      const fresh = items.filter((i) => i.ts > cutoff).slice(-HIST_MAX);
      if (c === H.c) {
        if (fresh.length !== H.items.length) {
          H.items = fresh;
          H.byK = new Map(fresh.map((i) => [i.k, i]));
          H.flush();
        }
      } else if (!fresh.length) store.del(key);
      else if (fresh.length !== items.length) store.set(key, JSON.stringify(fresh));
      fresh.forEach((i) => keep.add(clipUrl(c, i.k)));
    }
    try {
      const cache = await caches.open(MEDIA_CACHE);
      for (const req of await cache.keys()) {
        const u = new URL(req.url);
        if (!keep.has(u.pathname + u.search)) cache.delete(req);
      }
    } catch {}
  }

  async function dropMedia(c, ks) {
    if (!ks.length) return;
    try {
      const cache = await caches.open(MEDIA_CACHE);
      await Promise.all(ks.map((k) => cache.delete(clipUrl(c, k))));
    } catch {}
  }

  async function putMedia(c, k, bytes, type) {
    try {
      const cache = await caches.open(MEDIA_CACHE);
      await cache.put(clipUrl(c, k), new Response(bytes, { headers: { 'content-type': type } }));
    } catch {}
  }

  // Cache first: the service worker prefetches clips when an alert arrives.
  const inflight = new Map();
  function getMedia(c, k) {
    const url = clipUrl(c, k);
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      let cache = null;
      try {
        cache = await caches.open(MEDIA_CACHE);
        const hit = await cache.match(url);
        if (hit) return await hit.arrayBuffer();
      } catch {}
      const res = await fetch(url);
      if (res.status === 404) return 'gone';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (cache) cache.put(url, new Response(buf.slice(0), { headers: { 'content-type': res.headers.get('content-type') || '' } })).catch(() => {});
      return buf;
    })();
    inflight.set(url, p);
    p.catch(() => {}).finally(() => inflight.delete(url));
    return p;
  }

  function markRead(item) {
    if (!item || !item.u) return;
    item.u = 0;
    H.save();
    updateBadge();
    if (S.openSheet === els.historySheet) {
      const row = els.historyList.querySelector(`.msg[data-k="${item.k}"]`);
      if (row) row.classList.remove('unread');
      refreshMissedBtn();
    }
  }

  // Unread voice messages that aren't already queued or playing.
  function missedToPlay() {
    const busy = new Set(S.queue.map((q) => q.item.k));
    if (S.playing) busy.add(S.playing.item.k);
    return H.items.filter((i) => i.u && i.t === 'v' && !i.gone && !busy.has(i.k));
  }

  function refreshMissedBtn() {
    const n = missedToPlay().length;
    els.playMissedBtn.hidden = !n;
    els.playMissedBtn.lastChild.textContent = `Play ${n} missed`;
  }

  function updateBadge() {
    const n = S.joined ? H.unread() : 0;
    els.historyBadge.hidden = !n;
    els.historyBadge.textContent = n > 99 ? '99+' : String(n);
    try {
      if (n && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
      else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch {}
    renderNotice();
  }

  // -------------------------------------------------------------------------
  // Audio: context, session, sound cues, microphone
  // -------------------------------------------------------------------------
  // iOS: 'playback' makes messages audible with the silent switch on and
  // through the loudspeaker; 'play-and-record' is needed while recording.
  function setSession(type) {
    try {
      if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type;
    } catch {}
  }

  const audioRunning = () => !!S.ctx && S.ctx.state === 'running';

  function unlockAudio() {
    if (S.ctx && S.ctx.state === 'closed') {
      closeMic();
      S.ctx = null;
      S.recReady = null;
    }
    if (!S.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      S.ctx = new Ctx({ latencyHint: 'interactive' });
      S.ctx.onstatechange = () => {
        render();
        if (audioRunning()) playNext();
      };
      // A silent buffer fully unlocks output on iOS.
      const src = S.ctx.createBufferSource();
      src.buffer = S.ctx.createBuffer(1, 1, 22050);
      src.connect(S.ctx.destination);
      src.start(0);
    }
    if (S.ctx.state !== 'running') S.ctx.resume().catch(() => {});
  }

  function tone(seq, type = 'sine', vol = 0.12) {
    const ctx = S.ctx;
    if (!audioRunning()) return;
    let t = ctx.currentTime + 0.005;
    for (const [freq, dur] of seq) {
      if (freq) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.008);
        g.gain.setValueAtTime(vol, t + dur - 0.02);
        g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + dur + 0.01);
      }
      t += dur;
    }
  }

  function squelch(dur, vol) {
    const ctx = S.ctx;
    if (!audioRunning()) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    const band = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = buf;
    band.type = 'bandpass';
    band.frequency.value = 2600;
    band.Q.value = 0.8;
    g.gain.value = vol;
    src.connect(band).connect(g).connect(ctx.destination);
    src.start();
  }

  const sfx = {
    txStart: () => tone([[988, 0.055], [1480, 0.075]], 'sine', 0.13),
    txEnd: () => tone([[1480, 0.05], [988, 0.085]], 'sine', 0.11),
    rxStart: () => squelch(0.07, 0.35),
    rxEnd: () => squelch(0.16, 0.45),
    busy: () => tone([[370, 0.09], [0, 0.05], [370, 0.09]], 'square', 0.04),
    photo: () => tone([[1320, 0.06], [0, 0.03], [1760, 0.09]], 'sine', 0.08),
  };

  async function openMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
    }
    unlockAudio();
    if (!S.ctx || !S.ctx.audioWorklet) throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    const session = S.session;
    setSession('play-and-record');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      setSession(S.playing ? 'playback' : 'auto');
      throw err;
    }
    const gone = () => {
      stream.getTracks().forEach((t) => t.stop());
      return Object.assign(new Error('left'), { name: 'Left' });
    };
    try {
      if (!S.recReady) S.recReady = S.ctx.audioWorklet.addModule('/recorder.js');
      await S.recReady;
    } catch {
      S.recReady = null;
      gone();
      throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    }
    if (!S.joined || session !== S.session) throw gone();

    const track = stream.getAudioTracks()[0];
    if ('contentHint' in track) track.contentHint = 'speech';
    // Unplugged headset, phone call, another app took the mic: just drop it;
    // the next press opens it again.
    track.addEventListener('ended', () => {
      if (S.track !== track) return;
      if (S.flow) toast('Microphone disconnected');
      if (S.held) up();
      closeMic();
    });

    // mic -> analyser (level meter); mic -> recorder worklet -> muted output.
    // The worklet is only wired to the output while recording, so the audio
    // thread does no work when nobody is talking.
    const src = S.ctx.createMediaStreamSource(stream);
    const rec = new AudioWorkletNode(S.ctx, 'walki-rec');
    const mute = S.ctx.createGain();
    mute.gain.value = 0;
    const an = S.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    src.connect(rec);
    mute.connect(S.ctx.destination);
    rec.port.onmessage = (e) => {
      if (e.data) S.chunks.push(e.data);
      else if (S.recDone) S.recDone();
    };
    S.stream = stream;
    S.track = track;
    S.mic = { src, rec, mute, an };
    S.micAnalyser = an;
  }

  function ensureMic() {
    clearTimeout(S.micIdle);
    if (S.mic && S.track && S.track.readyState === 'live') return Promise.resolve();
    if (S.mic) closeMic();
    if (!S.micP) S.micP = openMic().finally(() => (S.micP = null));
    return S.micP;
  }

  function closeMicLater() {
    clearTimeout(S.micIdle);
    S.micIdle = setTimeout(() => {
      if (!S.flow) closeMic();
    }, MIC_IDLE_MS);
  }

  function closeMic() {
    clearTimeout(S.micIdle);
    if (S.mic) {
      for (const node of Object.values(S.mic)) try { node.disconnect(); } catch {}
      S.mic.rec.port.onmessage = null;
    }
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    const had = !!S.stream;
    S.stream = null;
    S.track = null;
    S.mic = null;
    S.micAnalyser = null;
    S.recording = false;
    if (had) setSession(S.playing ? 'playback' : 'auto');
  }

  function micError(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Allow microphone access to talk';
      case 'NotFoundError':
        return 'No microphone found';
      case 'NotReadableError':
        return 'Another app is using the microphone';
      case 'InsecureContext':
        return 'Open walki over HTTPS to use the microphone';
      case 'Unsupported':
        return 'This browser can’t record audio. Update it or try another one';
      default:
        return 'Could not start the microphone';
    }
  }

  function startRec() {
    S.chunks = [];
    S.recording = true;
    S.txStart = Date.now();
    try { S.mic.rec.connect(S.mic.mute); } catch {}
    S.mic.rec.port.postMessage(true);
  }

  function stopRecording() {
    return new Promise((resolve) => {
      let timer = 0;
      const mic = S.mic;
      const done = () => {
        clearTimeout(timer);
        S.recDone = null;
        S.recording = false;
        if (mic) try { mic.rec.disconnect(); } catch {}
        const pcm = concat(S.chunks);
        S.chunks = [];
        resolve(pcm);
      };
      timer = setTimeout(done, 500); // the worklet can't answer while audio is suspended
      S.recDone = done;
      if (mic && S.recording) mic.rec.port.postMessage(false);
      else done();
    });
  }

  // -------------------------------------------------------------------------
  // Clips: 8 kHz G.711 mu-law. Codec-free, so every browser can play every
  // other browser's clips, and small enough for slow connections.
  // -------------------------------------------------------------------------
  function toUlaw(x) {
    let s = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    s = Math.min(s, 32635) + 0x84;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
    return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
  }

  const ULAW = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const s = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7)) - 0x84;
    ULAW[i] = (u & 0x80 ? -s : s) / 32768;
  }

  function concat(chunks) {
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  // Box-filter downsample to 8 kHz, normalise quiet speech, encode.
  function encodeClip(pcm, inRate) {
    const step = inRate / CLIP_RATE;
    const n = Math.floor(pcm.length / step);
    const mid = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step);
      const b = Math.max(a + 1, Math.floor((i + 1) * step));
      let sum = 0;
      for (let j = a; j < b; j++) sum += pcm[j];
      mid[i] = sum / (b - a);
      peak = Math.max(peak, Math.abs(mid[i]));
    }
    const gain = peak > 0 ? Math.min(4, 0.9 / peak) : 1;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = toUlaw(mid[i] * gain);
    return out;
  }

  function decodeClip(bytes) {
    const rate = S.ctx.sampleRate;
    const len = Math.max(1, Math.floor((bytes.length * rate) / CLIP_RATE));
    const buf = S.ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);
    const step = CLIP_RATE / rate;
    for (let i = 0; i < len; i++) {
      const p = i * step;
      const j = Math.floor(p);
      const a = ULAW[bytes[j]];
      const b = ULAW[bytes[Math.min(bytes.length - 1, j + 1)]];
      out[i] = a + (b - a) * (p - j);
    }
    return buf;
  }

  // -------------------------------------------------------------------------
  // Server: plain HTTPS requests
  // -------------------------------------------------------------------------
  function api(action, { method = 'GET', params = {}, body, type, timeout = 10000, keepalive = false } = {}) {
    const q = new URLSearchParams({ c: S.channel, id: S.myId, name: S.name, ...params });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(`/api/${action}?${q}`, {
      method,
      body,
      cache: 'no-store',
      keepalive,
      signal: ctrl.signal,
      headers: body ? { 'content-type': type || 'application/octet-stream' } : undefined,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!data) throw new Error(`HTTP ${res.status}`);
        return data;
      })
      .finally(() => clearTimeout(timer));
  }

  function beacon(action) {
    if (!S.channel || !S.myId) return;
    const url = `/api/${action}?${new URLSearchParams({ c: S.channel, id: S.myId })}`;
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
    } catch {}
    fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
  }

  // Floor requests must reach the server in order: a quick second press must not
  // be granted before the first press's release or clip lands and clears it.
  function floorOp(action, opts) {
    const session = S.session;
    const run = () => (S.session === session && S.joined ? api(action, { method: 'POST', ...opts }) : { error: 'left' });
    const p = S.floorQ.then(run, run);
    S.floorQ = p.catch(() => {});
    return p;
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------
  async function poll() {
    clearTimeout(S.pollTimer);
    S.pollTimer = 0;
    if (!S.joined) return;
    if (S.polling) {
      S.pollAgain = true; // one request at a time; run again right after
      return;
    }
    S.polling = true;
    S.sleeping = false;
    const session = S.session;
    try {
      // keepalive: the "gone to background" poll must land even if the
      // phone freezes the page right after.
      const r = await api('poll', { params: { v: visible() ? '1' : '0', since: String(S.since || 0) }, keepalive: !visible() });
      if (session === S.session && S.joined) {
        if (r.error === 'full' || r.error === 'storage') {
          leave();
          showJoinError(r.error === 'full' ? 'That channel is full' : 'walki’s server storage isn’t set up yet');
        } else if (r.error) {
          throw new Error(r.error);
        } else {
          onState(r);
        }
      }
    } catch (err) {
      if (session === S.session && S.joined) {
        console.warn('poll', err);
        if (++S.failures >= 2) setOffline(true);
        render();
      }
    } finally {
      S.polling = false;
    }
    if (!S.joined) return;
    if (S.pollAgain || session !== S.session) {
      S.pollAgain = false;
      return poll();
    }
    const delay = nextPollDelay();
    if (delay == null) return sleep();
    S.pollTimer = setTimeout(poll, delay);
  }

  function nextPollDelay() {
    const now = Date.now();
    if (S.failures) return Math.min(visible() ? 10_000 : 30_000, 1500 * 2 ** Math.min(S.failures - 1, 5));
    const busy = S.talker || S.playing || S.flow || S.sending || S.queue.length;
    if (visible()) {
      if (busy || now - S.lastActivity < ACTIVE_WINDOW_MS) return POLL_ACTIVE_MS;
      return now - S.lastActivity < IDLE_AFTER_MS ? POLL_QUIET_MS : POLL_IDLE_MS;
    }
    if (busy) return 2000;
    const grace = S.pushOn ? BG_GRACE_PUSH_MS : BG_GRACE_MS;
    return now - S.hiddenAt > grace ? null : POLL_HIDDEN_MS;
  }

  // In the background for a while: stop all work. Alerts wake the phone, and
  // coming back on screen catches up on anything missed.
  function sleep() {
    S.sleeping = true;
    S.syncing = true;
    closeMic();
    if (S.ctx && S.ctx.state === 'running' && !S.playing) S.ctx.suspend().catch(() => {});
  }

  function onState(r) {
    const syncing = S.syncing;
    S.syncing = false;
    S.connected = true;
    S.failures = 0;
    setOffline(false);

    const before = S.members.size;
    S.members = new Map(r.members.map((m) => [m.id, m]));
    S.away = new Map((r.away || []).map((m) => [m.id, m.name]));
    if (!S.flow) S.talker = r.talker && r.talker !== S.myId ? r.talker : null;
    if (S.talker || S.members.size > before) S.lastActivity = Date.now();

    const seenKey = `walki:seen:${S.channel}`;
    const lastSeen = Number(store.get(seenKey)) || 0;
    let added = false;
    for (const clip of r.clips) {
      if (H.byK.has(clip.k)) continue;
      added = true;
      const item = { k: clip.k, from: clip.from, name: clip.name, ts: clip.ts, ms: clip.ms || 0, t: clip.t || 'v', u: 0 };
      if (clip.from === S.myId) {
        item.mine = true;
        H.add(item);
        continue;
      }
      if (syncing) {
        // Catching up after a launch or the background: anything newer than
        // the last check is a missed message. (First visit: just history.)
        item.u = lastSeen && clip.ts > lastSeen ? 1 : 0;
        H.add(item);
        continue;
      }
      item.u = 1;
      H.add(item);
      S.lastActivity = Date.now();
      if (item.t === 'p') {
        if (visible()) showPhotoCard(item);
      }
      else if (visible() || audioRunning()) enqueue(item, false);
    }
    S.since = r.now;
    store.set(seenKey, String(r.now));

    if (syncing && !sweep.done) {
      sweep.done = true;
      sweep();
    }
    if (added) {
      updateBadge();
      if (S.openSheet === els.historySheet) renderHistory();
    }
    if (S.pendingOpen) openPending();
    render();
  }

  // -------------------------------------------------------------------------
  // Playback queue. Live messages play first; history plays when asked.
  // -------------------------------------------------------------------------
  function enqueue(item, manual) {
    if ((S.playing && S.playing.item.k === item.k) || S.queue.some((q) => q.item.k === item.k)) return;
    const entry = { item, manual, data: getMedia(S.channel, item.k).catch(() => null) };
    const firstManual = S.queue.findIndex((q) => q.manual);
    if (!manual && firstManual >= 0) S.queue.splice(firstManual, 0, entry);
    else S.queue.push(entry);
    playNext();
  }

  async function playNext() {
    if (S.playing || S.flow || !S.queue.length || !S.joined) return render();
    if (!audioRunning()) {
      // Needs a tap first (the notice asks for one). Resume works if the
      // browser still counts an earlier tap.
      if (S.ctx) S.ctx.resume().catch(() => {});
      return render();
    }
    const entry = S.queue.shift();
    S.playing = entry;
    if (S.mic) closeMic(); // iOS plays through the earpiece while the mic is open
    setSession('playback');
    render();
    const data = await entry.data;
    if (S.playing !== entry) return;
    const item = entry.item;
    if (!data || data === 'gone') {
      if (data === 'gone') {
        item.gone = 1;
        markRead(item);
        H.save();
      }
      S.playing = null;
      if (entry.manual) toast(data === 'gone' ? 'That message has expired' : 'Couldn’t load that message');
      return playNext();
    }
    markRead(item);
    let buf;
    try {
      buf = decodeClip(new Uint8Array(data));
    } catch {
      S.playing = null;
      return playNext();
    }
    const src = S.ctx.createBufferSource();
    src.buffer = buf;
    const an = S.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an).connect(S.ctx.destination);
    entry.src = src;
    entry.startAt = S.ctx.currentTime + 0.08;
    entry.dur = buf.duration;
    S.rxAnalyser = an;
    src.onended = () => {
      if (S.playing !== entry) return;
      S.playing = null;
      S.rxAnalyser = null;
      sfx.rxEnd();
      if (!S.queue.length) setSession('auto');
      render();
      playNext();
    };
    sfx.rxStart();
    src.start(entry.startAt);
    S.lastActivity = Date.now();
    render();
  }

  // manualOnly: stop history playback but keep live messages queued.
  function stopPlayback(manualOnly = false) {
    const entry = S.playing;
    S.queue = manualOnly ? S.queue.filter((q) => !q.manual) : [];
    if (entry && (!manualOnly || entry.manual)) {
      S.playing = null;
      S.rxAnalyser = null;
      if (entry.src) {
        entry.src.onended = null;
        try { entry.src.stop(); } catch {}
      }
      if (!S.queue.length) setSession('auto');
    }
    render();
  }

  function playItem(item) {
    unlockAudio(); // inside the tap
    if (S.playing && S.playing.item.k === item.k) return stopPlayback(true);
    stopPlayback(true);
    if (S.playing || S.talker) toast('Plays after the current message');
    enqueue(item, true);
  }

  function playMissed() {
    unlockAudio();
    stopPlayback(true);
    missedToPlay().forEach((i) => enqueue(i, true));
    refreshMissedBtn();
  }

  // -------------------------------------------------------------------------
  // Push-to-talk / floor control
  // -------------------------------------------------------------------------

  // The mic opens and the floor is requested at the same time; the start beep
  // plays once both are ready, which is when people start speaking anyway.
  async function press() {
    if (!S.joined) return;
    unlockAudio();
    if (S.flow) {
      // Pressed again before the last press wrapped up: carry on with the
      // pending one, or start a fresh one as soon as it has finished.
      if (S.finishing) S.again = true;
      else if (!S.pressing) {
        S.pressing = true;
        haptic(10);
        render();
      }
      return;
    }
    if (S.pressing) return;
    haptic(10);
    S.lastActivity = Date.now();
    if (S.playing && S.playing.manual) stopPlayback(true);
    if (S.playing || S.talker) return deny();
    if (!S.connected) {
      toast('Still connecting…');
      return deny();
    }
    S.pressing = S.flow = true;
    S.chunks = [];
    S.txStart = Date.now();
    render();

    const floor = floorOp('talk').catch(() => ({ error: 'network' }));
    let micErr = null;
    try {
      await ensureMic();
    } catch (err) {
      micErr = err;
    }
    if (!micErr && S.flow && S.mic) startRec();
    const res = await floor;
    if (micErr || !res.ok || !S.recording) {
      S.finishing = true;
      if (S.recording) await stopRecording();
      S.pressing = S.flow = S.finishing = S.again = false;
      if (res.ok) floorOp('release').catch(() => {});
      if (micErr) {
        if (S.joined && micErr.name !== 'Left') toast(micError(micErr));
      } else if (res.busy) {
        S.talker = res.busy;
        deny();
      } else if (!res.ok && res.error !== 'left') {
        toast('Could not reach walki');
      }
      render();
      closeMicLater();
      return playNext();
    }

    S.tx = true;
    if (!S.pressing) return finishTx(); // let go before the floor was granted
    sfx.txStart();
    haptic(18);
    S.txTimer = setTimeout(() => {
      toast('Time limit reached');
      release();
    }, MAX_TALK_MS - (Date.now() - S.txStart));
    render();
  }

  function release() {
    if (!S.pressing) return;
    S.pressing = false;
    if (S.tx) finishTx();
    render();
  }

  async function finishTx() {
    const audible = !!S.txTimer; // the start beep played
    clearTimeout(S.txTimer);
    S.txTimer = 0;
    S.tx = false;
    S.finishing = true;
    const ms = Date.now() - S.txStart;
    const pcm = await stopRecording();
    S.flow = S.finishing = false;
    if (audible) sfx.txEnd();
    render();

    const sent = S.joined && ms >= MIN_CLIP_MS && pcm.length;
    const retry = S.again && S.held; // let go and pressed again meanwhile
    S.again = false;
    if (!sent) {
      floorOp('release').catch(() => {});
      if (S.joined && !retry) toast(ms < MIN_CLIP_MS ? 'Hold the button to talk' : 'Microphone wasn’t ready, try again');
    }
    if (retry) press();
    else closeMicLater();
    playNext();
    if (!sent) return;

    S.sending++;
    render();
    const channel = S.channel;
    try {
      const bytes = encodeClip(pcm, S.ctx.sampleRate);
      const r = await floorOp('clip', { params: { ms: String(ms), t: 'v' }, body: bytes, timeout: 30000 });
      if (!r.ok) throw new Error(r.error);
      if (S.joined && S.channel === channel) {
        putMedia(channel, r.k, bytes, 'application/octet-stream');
        H.add({ k: r.k, from: S.myId, name: S.name, ts: r.ts || Date.now(), ms, t: 'v', u: 0, mine: true });
        if (S.openSheet === els.historySheet) renderHistory();
      }
    } catch (err) {
      console.warn('clip', err);
      if (S.joined) toast('Message not sent. Check your connection');
      floorOp('release').catch(() => {});
    }
    S.sending--;
    render();
  }

  function deny() {
    sfx.busy();
    haptic([30, 60, 30]);
    els.pttWrap.classList.remove('deny');
    void els.pttWrap.offsetWidth;
    els.pttWrap.classList.add('deny');
  }
  els.pttWrap.addEventListener('animationend', (e) => {
    if (e.animationName === 'shake') els.pttWrap.classList.remove('deny');
  });

  function down() {
    S.held = true;
    press();
  }
  function up() {
    S.held = false;
    S.again = false;
    release();
  }

  // Pointer (touch, pen, mouse). Only the first finger counts, so a second
  // finger landing or lifting doesn't cut the transmission.
  els.ptt.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    try { els.ptt.setPointerCapture(e.pointerId); } catch {}
    down();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    els.ptt.addEventListener(ev, (e) => {
      if (!e.isPrimary) return;
      // iOS only lets audio resume from the end of a touch.
      if (ev === 'pointerup') unlockAudio();
      if (S.held) up();
    });
  }
  els.ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  for (const ev of ['touchstart', 'touchend']) els.ptt.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

  // Any tap turns sound on (browsers only allow audio after a tap).
  for (const ev of ['pointerdown', 'pointerup']) {
    document.addEventListener(ev, () => {
      if (S.joined && !audioRunning()) unlockAudio();
    }, { capture: true, passive: true });
  }

  // Keyboard: hold Space (or Enter on the focused button)
  const isTyping = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
  const overlayOpen = () => !!S.openSheet || !els.camera.hidden || !els.viewer.hidden;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.viewer.hidden) return closeViewer();
      if (S.openSheet) return closeSheet();
    }
    if (body.dataset.screen !== 'radio' || isTyping() || overlayOpen() || e.repeat) return;
    if (e.code === 'Space' || (e.key === 'Enter' && document.activeElement === els.ptt)) {
      e.preventDefault();
      down();
    }
  });
  window.addEventListener('keyup', (e) => {
    if ((e.code === 'Space' || e.key === 'Enter') && S.held) up();
  });
  window.addEventListener('blur', () => S.held && up());

  // -------------------------------------------------------------------------
  // Photos (dual camera)
  // -------------------------------------------------------------------------
  let cameraLoad = null;
  function loadCamera() {
    if (window.WalkiCamera) return Promise.resolve();
    if (!cameraLoad) {
      cameraLoad = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/camera.js';
        s.onload = resolve;
        s.onerror = () => {
          cameraLoad = null;
          reject(new Error('load'));
        };
        document.head.appendChild(s);
      });
    }
    return cameraLoad;
  }

  els.cameraBtn.addEventListener('click', async () => {
    if (!S.joined || !els.camera.hidden) return;
    if (S.held) up();
    try {
      await loadCamera();
    } catch {
      return toast('Couldn’t open the camera. Check your connection');
    }
    if (!S.joined || !els.camera.hidden) return;
    closeMic(); // phones can't share the hardware well
    window.WalkiCamera.open({ onSend: sendPhoto, toast });
  });

  async function sendPhoto(blob) {
    if (!S.joined) return;
    const channel = S.channel;
    S.sending++;
    render();
    toast('Sending photo…', 60_000);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const r = await api('clip', { method: 'POST', params: { t: 'p' }, body: bytes, type: 'image/jpeg', timeout: 60_000 });
      if (!r.ok) throw new Error(r.error);
      if (S.joined && S.channel === channel) {
        await putMedia(channel, r.k, bytes, 'image/jpeg');
        H.add({ k: r.k, from: S.myId, name: S.name, ts: r.ts || Date.now(), ms: 0, t: 'p', u: 0, mine: true });
        if (S.openSheet === els.historySheet) renderHistory();
      }
      toast('Photo sent');
      haptic(15);
    } catch (err) {
      console.warn('photo', err);
      toast('Photo not sent. Check your connection');
    }
    S.sending--;
    S.lastActivity = Date.now();
    render();
  }

  async function photoUrl(item) {
    const data = await getMedia(S.channel, item.k);
    if (!data || data === 'gone') return null;
    return URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
  }

  let cardTimer = 0;
  let cardUrl = '';
  let cardItem = null;
  async function showPhotoCard(item) {
    const url = await photoUrl(item).catch(() => null);
    if (!url || !S.joined) return;
    hidePhotoCard();
    cardUrl = url;
    cardItem = item;
    els.photoCardImg.src = url;
    els.photoCardName.textContent = item.name;
    els.photoCard.hidden = false;
    renderNotice();
    requestAnimationFrame(() => els.photoCard.classList.add('show'));
    sfx.photo();
    haptic([20, 40, 20]);
    cardTimer = setTimeout(hidePhotoCard, 7000);
  }
  function hidePhotoCard() {
    clearTimeout(cardTimer);
    els.photoCard.classList.remove('show');
    const url = cardUrl;
    cardUrl = '';
    cardItem = null;
    renderNotice();
    setTimeout(() => {
      if (!cardUrl) els.photoCard.hidden = true;
      if (url) URL.revokeObjectURL(url);
    }, 400);
  }
  els.photoCard.addEventListener('click', () => {
    const item = cardItem;
    hidePhotoCard();
    if (item) openViewer(item);
  });

  let viewerUrl = '';
  let viewerItem = null;
  async function openViewer(item) {
    const url = await photoUrl(item).catch(() => null);
    if (!url) {
      if (item.u) markRead(item);
      return toast('That photo has expired');
    }
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = url;
    viewerItem = item;
    els.viewerImg.src = url;
    els.viewerName.textContent = item.mine ? 'You' : item.name;
    els.viewerTime.textContent = `${fmtDay(item.ts)} · ${fmtClock(item.ts)}`;
    markRead(item);
    if (S.openSheet === els.historySheet) renderHistory();
    els.viewer.hidden = false;
    requestAnimationFrame(() => els.viewer.classList.add('open'));
    pushNav('viewer');
  }
  function closeViewer(fromNav) {
    if (els.viewer.hidden) return;
    els.viewer.classList.remove('open');
    setTimeout(() => {
      if (els.viewer.classList.contains('open')) return;
      els.viewer.hidden = true;
      els.viewerImg.removeAttribute('src');
      if (viewerUrl) URL.revokeObjectURL(viewerUrl);
      viewerUrl = '';
    }, 250);
    if (!fromNav) popNav('viewer');
  }
  els.viewerClose.addEventListener('click', () => closeViewer());
  els.viewer.addEventListener('click', (e) => {
    if (e.target === els.viewer) closeViewer();
  });
  els.viewerSave.addEventListener('click', async () => {
    if (!viewerUrl || !viewerItem) return;
    const name = `walki-${new Date(viewerItem.ts).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
    try {
      const blob = await (await fetch(viewerUrl)).blob();
      const file = new File([blob], name, { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = viewerUrl;
    a.download = name;
    a.click();
  });

  // -------------------------------------------------------------------------
  // Background alerts (Web Push)
  // -------------------------------------------------------------------------
  const Push = {
    supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    key: null,
    // on | off | blocked | install (iPhone: add to Home Screen first) | unsupported
    state() {
      if (!this.supported) return isIOS && !standalone() ? 'install' : 'unsupported';
      if (Notification.permission === 'denied') return 'blocked';
      if (Notification.permission === 'granted' && store.get('walki:push') !== '0') return 'on';
      return 'off';
    },
    async publicKey() {
      if (!this.key) {
        const r = await fetch('/api/key', { cache: 'no-store' }).then((res) => res.json());
        if (!r.key) throw new Error('no key');
        this.key = r.key;
      }
      return this.key;
    },
    async subscribe() {
      const reg = await navigator.serviceWorker.ready;
      const key = b64url(await this.publicKey());
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameBytes(sub.options && sub.options.applicationServerKey, key)) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const r = await api('sub', { method: 'POST', body: JSON.stringify(sub), type: 'text/plain' });
      if (!r.ok) throw new Error(r.error || 'sub');
      S.pushOn = true;
      S.pushSynced = S.channel;
    },
    // Must run inside a tap.
    async enable() {
      if (!this.supported) return;
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        render();
        return toast(perm === 'denied' ? 'Alerts are blocked. Allow them in your browser settings' : 'Alerts stay off');
      }
      store.set('walki:push', '1');
      try {
        await this.subscribe();
        toast('Alerts on. You’ll hear about messages while walki is closed', 3200);
      } catch (err) {
        console.warn('push', err);
        toast('Couldn’t turn on alerts, try again');
      }
      render();
    },
    async disable() {
      store.set('walki:push', '0');
      S.pushOn = false;
      S.pushSynced = '';
      api('unsub', { method: 'POST' }).catch(() => {});
      render();
    },
    // On join / return: make sure this channel will alert this device.
    sync() {
      if (this.state() !== 'on' || S.pushSynced === S.channel || !S.joined) return;
      this.subscribe().catch((err) => console.warn('push sync', err));
    },
  };

  function b64url(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  }
  function sameBytes(buf, bytes) {
    if (!buf) return false;
    const a = new Uint8Array(buf);
    return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
  }

  function clearAlerts() {
    try {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ type: 'clear', c: S.channel });
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    S.installEvt = e;
    renderMenu();
  });
  window.addEventListener('appinstalled', () => {
    S.installEvt = null;
    renderMenu();
    toast('walki installed');
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  const memberEls = new Map();

  function renderMembers() {
    const list = [{ key: 'self', name: S.name, me: true, talking: S.tx }];
    for (const [id, m] of S.members) {
      list.push({ key: id, name: m.name, talking: S.talker === id || (S.playing && !S.playing.manual && S.playing.item.from === id) });
    }
    for (const [id, name] of S.away) list.push({ key: id, name, away: true });

    const seen = new Set();
    for (const m of list) {
      seen.add(m.key);
      let el = memberEls.get(m.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'member';
        el.innerHTML = '<div class="avatar"></div><div class="member-name"></div>';
        els.members.insertBefore(el, els.inviteChip);
        memberEls.set(m.key, el);
      }
      const label = m.me ? 'You' : m.name;
      const av = el.firstChild;
      const nm = el.lastChild;
      const ini = initials(m.name);
      if (av.textContent !== ini) av.textContent = ini;
      if (nm.textContent !== label) nm.textContent = label;
      el.classList.toggle('me', !!m.me);
      el.classList.toggle('away', !!m.away);
      el.classList.toggle('talking', !!m.talking);
      el.title = m.away ? `${m.name} · away, gets alerts` : m.name;
    }
    for (const [key, el] of memberEls) {
      if (seen.has(key)) continue;
      memberEls.delete(key);
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }
  }

  function setCaption(main, sub) {
    if (els.captionMain.textContent !== main) {
      els.captionMain.textContent = main;
      els.caption.classList.remove('swap');
      void els.caption.offsetWidth;
      els.caption.classList.add('swap');
    }
    if (els.captionSub.textContent !== sub) els.captionSub.textContent = sub;
  }

  function render() {
    const offline = body.classList.contains('offline');
    let state = 'idle';
    if (S.tx) state = 'tx';
    else if (S.pressing) state = 'pending';
    else if (S.playing || S.talker) state = 'rx';
    S.state = state;
    if (body.dataset.state !== state) body.dataset.state = state;
    els.pttWrap.classList.toggle('rx-tone', state === 'rx');

    const others = S.members.size;
    const away = S.away.size;
    let status = others ? `${others + 1} online` : 'Only you here';
    if (away) status += ` · ${away} away`;
    if (offline) els.statusText.textContent = S.connected ? 'Reconnecting…' : 'Connecting…';
    else els.statusText.textContent = status;

    if (offline && state === 'idle') setCaption('Hold to talk', 'Waiting for connection');
    else if (state === 'tx') setCaption('Talking', `Release to send · ${fmtTime(Date.now() - S.txStart)}`);
    else if (state === 'pending') setCaption('Hold to talk', 'Getting ready…');
    else if (state === 'rx' && S.playing) {
      const it = S.playing.item;
      setCaption(it.mine ? 'You' : it.name, S.playing.manual ? `Message from ${fmtClock(it.ts)}` : 'is talking');
    } else if (state === 'rx') {
      const m = S.members.get(S.talker);
      setCaption((m && m.name) || 'Someone', 'is talking · plays when they let go');
    } else if (S.sending) setCaption('Hold to talk', 'Sending…');
    else setCaption('Hold to talk', others || away ? 'Channel is clear' : 'Invite someone to start talking');

    els.ptt.setAttribute('aria-pressed', String(state === 'tx'));
    els.ptt.setAttribute('aria-label', state === 'rx' && !S.playing?.manual ? 'Channel busy' : 'Hold to talk');

    renderMembers();
    renderNotice();
    markPlayingRow();
    if ((state === 'tx' || state === 'rx') && !S.raf) S.raf = requestAnimationFrame(meter);
  }

  // One banner at a time, most urgent first.
  function renderNotice() {
    let kind = '';
    let text = '';
    let act = '';
    const unread = H.unread();
    const alerts = Push.state();
    if (S.joined && S.queue.length && !audioRunning() && !S.playing) {
      kind = 'sound';
      text = `Tap to hear ${S.queue.length === 1 ? 'a new message' : `${S.queue.length} new messages`}`;
    } else if (S.joined && unread && !S.playing && !cardItem) {
      kind = 'missed';
      text = `${unread} missed ${unread === 1 ? 'message' : 'messages'}`;
      act = H.items.some((i) => i.u && i.t === 'v' && !i.gone) ? 'Play' : 'View';
    } else if (S.joined && S.connected && alerts === 'off' && !store.get('walki:askAlerts')) {
      kind = 'alerts';
      text = 'Get alerts when walki is closed';
      act = 'Turn on';
    } else if (S.joined && S.connected && alerts === 'install' && !store.get('walki:askInstall')) {
      kind = 'install';
      text = 'Add walki to your Home Screen for alerts';
      act = 'How';
    }
    els.notice.dataset.kind = kind;
    if (!kind) {
      if (!els.notice.hidden) els.notice.hidden = true;
      return;
    }
    if (els.noticeText.textContent !== text) els.noticeText.textContent = text;
    els.noticeAct.textContent = act;
    els.noticeAct.hidden = !act;
    els.noticeClose.hidden = kind !== 'alerts' && kind !== 'install';
    els.notice.hidden = false;
  }

  els.noticeMain.addEventListener('click', () => noticeAction(false));
  els.noticeAct.addEventListener('click', () => noticeAction(true));
  els.noticeClose.addEventListener('click', () => {
    store.set(els.notice.dataset.kind === 'install' ? 'walki:askInstall' : 'walki:askAlerts', '1');
    renderNotice();
  });
  function noticeAction(isAct) {
    switch (els.notice.dataset.kind) {
      case 'sound':
        unlockAudio();
        playNext();
        break;
      case 'missed':
        if (isAct && els.noticeAct.textContent === 'Play') playMissed();
        else openSheet(els.historySheet);
        break;
      case 'alerts':
        Push.enable();
        break;
      case 'install':
        openSheet(els.menuSheet);
        break;
    }
  }

  // Live voice level -> --level, which drives the halo and icon scale.
  let lastSecond = -1;
  function meter() {
    if (S.state !== 'tx' && S.state !== 'rx') {
      S.raf = 0;
      S.level = 0;
      els.pttWrap.style.setProperty('--level', '0');
      return;
    }
    const an = S.state === 'tx' ? S.micAnalyser : S.rxAnalyser;
    let raw = 0;
    if (an) {
      an.getFloatTimeDomainData(S.levelBuf);
      let sum = 0;
      for (let i = 0; i < S.levelBuf.length; i++) sum += S.levelBuf[i] * S.levelBuf[i];
      raw = Math.sqrt(sum / S.levelBuf.length);
    }
    if (S.state === 'tx') {
      const sec = Math.floor((Date.now() - S.txStart) / 1000);
      if (sec !== lastSecond) {
        lastSecond = sec;
        els.captionSub.textContent = `Release to send · ${fmtTime(Date.now() - S.txStart)}`;
      }
    }
    if (S.playing && S.playing.src && playingRow) {
      const p = Math.min(1, Math.max(0, (S.ctx.currentTime - S.playing.startAt) / S.playing.dur));
      playingRow.style.setProperty('--p', p.toFixed(3));
    }
    const target = Math.min(1, Math.sqrt(raw) * 1.6);
    S.level += (target - S.level) * (target > S.level ? 0.45 : 0.12);
    els.pttWrap.style.setProperty('--level', S.level.toFixed(3));
    S.raf = requestAnimationFrame(meter);
  }

  function setOffline(off) {
    body.classList.toggle('offline', off);
  }

  // -------------------------------------------------------------------------
  // History sheet
  // -------------------------------------------------------------------------
  const thumbs = new Map(); // k -> object URL, while the sheet is open
  let thumbIO = null;
  let playingRow = null;

  function renderHistory() {
    const list = els.historyList;
    const top = list.scrollTop;
    list.textContent = '';
    playingRow = null;
    refreshMissedBtn();

    if (!H.items.length) {
      list.innerHTML = '<div class="empty"><svg><use href="#i-history"/></svg><b>No messages yet</b><span>Voice messages and photos show up here, including ones you miss while walki is closed.</span></div>';
      return;
    }
    if (thumbIO) thumbIO.disconnect();
    thumbIO = 'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && loadThumb(e.target)), { root: list, rootMargin: '200px' })
      : null;

    const frag = document.createDocumentFragment();
    let day = '';
    for (let i = H.items.length - 1; i >= 0; i--) {
      const it = H.items[i];
      const d = fmtDay(it.ts);
      if (d !== day) {
        day = d;
        const h = document.createElement('div');
        h.className = 'day';
        h.textContent = d;
        frag.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = `msg${it.u ? ' unread' : ''}${it.mine ? ' mine' : ''}${it.gone ? ' gone' : ''}`;
      row.dataset.k = it.k;
      const av = document.createElement('div');
      av.className = 'avatar sm';
      av.textContent = initials(it.name);
      const main = document.createElement('div');
      main.className = 'msg-main';
      const head = document.createElement('div');
      head.className = 'msg-head';
      const who = document.createElement('b');
      who.textContent = it.mine ? 'You' : it.name;
      const time = document.createElement('time');
      time.textContent = fmtClock(it.ts);
      head.append(who, time);
      main.appendChild(head);
      if (it.t === 'p') {
        const b = document.createElement('button');
        b.className = 'msg-photo';
        b.dataset.act = 'view';
        b.setAttribute('aria-label', `Photo from ${who.textContent}`);
        const img = document.createElement('img');
        img.alt = '';
        img.dataset.k = it.k;
        b.appendChild(img);
        main.appendChild(b);
        if (it.gone) b.disabled = true;
        else if (thumbs.has(it.k)) img.src = thumbs.get(it.k);
        else if (thumbIO) thumbIO.observe(img);
        else loadThumb(img);
      } else {
        const v = document.createElement('div');
        v.className = 'msg-voice';
        v.innerHTML = '<button class="msg-play" data-act="play"><svg class="i-play"><use href="#i-play"/></svg><svg class="i-pause"><use href="#i-pause"/></svg></button><div class="msg-bar"><i></i></div><span class="msg-dur"></span>';
        v.firstChild.setAttribute('aria-label', `Play message from ${who.textContent}`);
        v.lastChild.textContent = it.gone ? 'Expired' : fmtTime(it.ms);
        if (it.gone) v.firstChild.disabled = true;
        main.appendChild(v);
      }
      const dot = document.createElement('i');
      dot.className = 'msg-dot';
      row.append(av, main, dot);
      frag.appendChild(row);
    }
    list.appendChild(frag);
    list.scrollTop = top;
    markPlayingRow();
  }

  async function loadThumb(img) {
    if (thumbIO) thumbIO.unobserve(img);
    const k = img.dataset.k;
    const item = H.byK.get(k);
    if (!item || thumbs.has(k)) return;
    thumbs.set(k, '');
    const url = await photoUrl(item).catch(() => null);
    if (!url) {
      thumbs.delete(k);
      return;
    }
    if (S.openSheet !== els.historySheet) return URL.revokeObjectURL(url);
    thumbs.set(k, url);
    const el = els.historyList.querySelector(`img[data-k="${k}"]`);
    if (el) el.src = url;
  }

  function releaseThumbs() {
    if (thumbIO) thumbIO.disconnect();
    thumbIO = null;
    for (const url of thumbs.values()) if (url) URL.revokeObjectURL(url);
    thumbs.clear();
  }

  function markPlayingRow() {
    const k = S.playing && S.playing.item.k;
    if (playingRow && playingRow.dataset.k !== k) {
      playingRow.classList.remove('playing');
      playingRow.style.removeProperty('--p');
      playingRow = null;
    }
    if (k && !playingRow && S.openSheet === els.historySheet) {
      playingRow = els.historyList.querySelector(`.msg[data-k="${k}"]`);
      if (playingRow) {
        playingRow.classList.add('playing');
        playingRow.classList.remove('unread');
      }
    }
  }

  els.historyList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const item = H.byK.get(btn.closest('.msg').dataset.k);
    if (!item) return;
    if (btn.dataset.act === 'play') playItem(item);
    else openViewer(item);
  });
  els.playMissedBtn.addEventListener('click', playMissed);

  // -------------------------------------------------------------------------
  // Sheets (history, settings). The Back button / gesture closes them.
  // -------------------------------------------------------------------------
  function pushNav(name) {
    try {
      if (history.state && history.state.overlay) history.replaceState({ overlay: name }, '');
      else history.pushState({ overlay: name }, '');
    } catch {}
  }
  function popNav(name) {
    try {
      if (history.state && history.state.overlay === name) history.back();
    } catch {}
  }
  window.addEventListener('popstate', () => {
    if (!els.viewer.hidden) closeViewer(true);
    else if (S.openSheet) closeSheet(true);
  });

  function openSheet(el) {
    if (S.openSheet === el) return;
    if (S.openSheet) closeSheet(true);
    if (S.held) up();
    S.openSheet = el;
    if (el === els.historySheet) renderHistory();
    if (el === els.menuSheet) renderMenu();
    el.hidden = false;
    els.scrim.hidden = false;
    el.style.transform = '';
    requestAnimationFrame(() => {
      el.classList.add('open');
      els.scrim.classList.add('open');
    });
    pushNav('sheet');
    const first = el.querySelector('[data-close]');
    if (first) first.focus({ preventScroll: true });
  }

  function closeSheet(fromNav) {
    const el = S.openSheet;
    if (!el) return;
    S.openSheet = null;
    el.classList.remove('open');
    el.style.transform = '';
    els.scrim.classList.remove('open');
    if (el === els.historySheet) {
      playingRow = null;
      releaseThumbs();
    }
    setTimeout(() => {
      if (S.openSheet !== el) el.hidden = true;
      if (!S.openSheet) els.scrim.hidden = true;
    }, 320);
    if (!fromNav) popNav('sheet');
  }

  els.scrim.addEventListener('click', () => closeSheet());
  for (const sheet of [els.historySheet, els.menuSheet]) {
    sheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeSheet();
    });
    // Drag the handle or header down to close.
    const grip = sheet.querySelector('.sheet-head');
    let startY = 0;
    let dy = 0;
    let dragging = false;
    const handle = sheet.querySelector('.sheet-grip');
    for (const target of [grip, handle]) {
      target.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        startY = e.clientY;
        dy = 0;
        sheet.classList.add('dragging');
        try { target.setPointerCapture(e.pointerId); } catch {}
      });
      target.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        dy = Math.max(0, e.clientY - startY);
        sheet.style.transform = `translateY(${dy}px)`;
      });
      const end = () => {
        if (!dragging) return;
        dragging = false;
        sheet.classList.remove('dragging');
        if (dy > 90) closeSheet();
        else sheet.style.transform = '';
      };
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    }
  }

  els.historyBtn.addEventListener('click', () => openSheet(els.historySheet));
  els.menuBtn.addEventListener('click', () => openSheet(els.menuSheet));

  function renderMenu() {
    els.menuTitle.textContent = `#${S.channel}`;
    const st = Push.state();
    els.alertsToggle.checked = st === 'on';
    els.alertsToggle.disabled = st === 'unsupported' || st === 'install' || st === 'blocked';
    els.alertsSub.textContent = {
      on: 'On. You’ll be notified when walki is closed',
      off: 'Get notified when walki is closed',
      blocked: 'Blocked. Allow notifications for this site in settings',
      install: 'Add walki to your Home Screen first',
      unsupported: 'Not available in this browser',
    }[st];
    els.awakeToggle.checked = store.get('walki:awake') === '1';
    const iosHint = isIOS && !standalone();
    els.installRow.hidden = !S.installEvt && !iosHint;
    els.installSub.textContent = iosHint ? 'Tap Share, then “Add to Home Screen”' : 'Opens like an app, with alerts';
    const n = H.items.length;
    els.storageSub.textContent = n ? `${n} saved ${n === 1 ? 'message' : 'messages'} on this device` : 'Nothing saved yet';
  }

  els.alertsToggle.addEventListener('change', () => {
    if (els.alertsToggle.checked) Push.enable().then(renderMenu);
    else Push.disable().then(renderMenu);
  });
  els.awakeToggle.addEventListener('change', () => {
    store.set('walki:awake', els.awakeToggle.checked ? '1' : '0');
    if (els.awakeToggle.checked) keepAwake();
    else if (S.wakeLock) S.wakeLock.release().catch(() => {});
  });
  els.installRow.addEventListener('click', async () => {
    if (!S.installEvt) return toast('In Safari tap Share, then “Add to Home Screen”', 3500);
    const evt = S.installEvt;
    S.installEvt = null;
    evt.prompt();
    await evt.userChoice.catch(() => {});
    renderMenu();
  });
  els.clearRow.addEventListener('click', () => {
    if (!H.items.length) return;
    if (!confirm('Clear all saved messages in this channel from this device?')) return;
    stopPlayback(true);
    H.clear();
    updateBadge();
    renderMenu();
    toast('History cleared');
  });
  els.leaveRow.addEventListener('click', () => {
    closeSheet();
    leave();
  });
  els.inviteRow.addEventListener('click', share);
  els.inviteChip.addEventListener('click', share);

  // -------------------------------------------------------------------------
  // Join / leave
  // -------------------------------------------------------------------------
  function showScreen(name) {
    body.dataset.screen = name;
    $('join').setAttribute('aria-hidden', String(name !== 'join'));
    $('radio').setAttribute('aria-hidden', String(name !== 'radio'));
  }

  function showJoinError(text, field) {
    els.joinError.textContent = text;
    if (field) field.focus();
  }

  function setLoading(on) {
    els.joinBtn.classList.toggle('loading', on);
    els.joinBtn.disabled = on;
  }

  els.channelInput.addEventListener('input', () => {
    const v = els.channelInput.value.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9-]/g, '');
    if (v !== els.channelInput.value) els.channelInput.value = v;
  });

  let joining = false;
  els.joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (joining) return;
    const name = els.nameInput.value.trim().slice(0, 20);
    const channel = normalizeChannel(els.channelInput.value);
    if (!name) return showJoinError('Enter your name', els.nameInput);
    if (!channel) return showJoinError('Enter a channel name', els.channelInput);
    showJoinError('');
    if (document.activeElement) document.activeElement.blur();

    joining = true;
    unlockAudio(); // must run inside the tap
    setLoading(true);
    join(name, channel);
    // Ask for the microphone now, so the first press doesn't hit a prompt.
    try {
      await ensureMic();
      closeMicLater();
    } catch (err) {
      if (err.name === 'InsecureContext' || err.name === 'Unsupported') {
        leave();
        showJoinError(micError(err));
      } else if (err.name !== 'Left') {
        toast(`${micError(err)}. You can still listen`, 3500);
      }
    }
    setLoading(false);
    joining = false;
  });

  function join(name, channel) {
    S.session++;
    S.myId = deviceId();
    S.name = name;
    S.channel = channel;
    S.joined = true;
    S.connected = false;
    S.failures = 0;
    S.syncing = true;
    S.since = 0;
    S.sleeping = false;
    S.hiddenAt = visible() ? 0 : Date.now();
    S.members = new Map();
    S.away = new Map();
    S.talker = null;
    S.lastActivity = Date.now();
    S.pushSynced = '';
    S.pushOn = Push.state() === 'on';
    H.load(channel);
    store.set('walki:name', name);
    store.set('walki:channel', channel);
    store.set('walki:joined', channel);
    try { history.replaceState(null, '', `/?c=${encodeURIComponent(channel)}`); } catch {}

    els.channelName.textContent = `#${channel}`;
    setOffline(true);
    showScreen('radio');
    render();
    updateBadge();
    keepAwake();
    clearAlerts();
    poll();
    Push.sync();
    // Ask the browser not to evict saved messages (granted to installed apps).
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  function leave() {
    if (!S.joined) return;
    up();
    beacon('leave');
    S.joined = false;
    S.session++;
    clearTimeout(S.pollTimer);
    stopPlayback();
    closeMic();
    hidePhotoCard();
    closeSheet();
    if (window.WalkiCamera) window.WalkiCamera.close();
    if (S.wakeLock) S.wakeLock.release().catch(() => {});
    S.members.clear();
    S.away.clear();
    S.talker = null;
    S.connected = false;
    S.pushSynced = '';
    store.del('walki:joined');
    store.del(`walki:seen:${S.channel}`);
    H.flush();
    setOffline(false);
    render();
    updateBadge();
    showScreen('join');
  }
  els.leaveBtn.addEventListener('click', leave);

  async function share() {
    const url = `${location.origin}/?c=${encodeURIComponent(S.channel)}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'walki', text: `Join #${S.channel} on walki`, url }); } catch {}
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied');
    } catch {
      toast(url);
    }
  }

  // Opened from an alert: show that message once it has synced.
  function openPending() {
    const item = H.byK.get(S.pendingOpen);
    if (!item) {
      if (!S.syncing) S.pendingOpen = '';
      return;
    }
    S.pendingOpen = '';
    if (item.t === 'p') return openViewer(item);
    openSheet(els.historySheet);
    stopPlayback(true);
    // Plays right away if sound is unlocked, otherwise on the next tap.
    const missed = H.items.filter((i) => i.u && i.t === 'v' && !i.gone && i.ts >= item.ts);
    if (!missed.includes(item)) missed.unshift(item);
    missed.forEach((i) => enqueue(i, true));
  }

  // -------------------------------------------------------------------------
  // Lifecycle: background, sleep, network changes
  // -------------------------------------------------------------------------
  async function keepAwake() {
    if (store.get('walki:awake') !== '1' || !S.joined) return;
    if (!('wakeLock' in navigator) || S.wakeLock || !visible()) return;
    try {
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wakeLock.addEventListener('release', () => (S.wakeLock = null));
    } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    if (!visible()) {
      if (S.held) up();
      S.hiddenAt = Date.now();
      if (!S.joined) return;
      if (!S.flow) closeMic();
      hidePhotoCard();
      poll(); // tells the server right away that alerts are needed now
      return;
    }
    S.hiddenAt = 0;
    if (!S.joined) return;
    keepAwake();
    if (S.ctx && S.ctx.state !== 'running') S.ctx.resume().catch(() => {});
    clearAlerts();
    Push.sync();
    poll();
  });

  window.addEventListener('online', poll);
  window.addEventListener('pagehide', () => {
    if (S.joined) {
      H.flush();
      beacon('away');
    }
  });
  window.addEventListener('pageshow', (e) => e.persisted && poll());
  document.addEventListener('resume', poll); // Chrome unfroze the page

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'poll') poll();
      else if (d.type === 'resubscribe') {
        S.pushSynced = '';
        Push.sync();
      } else if (d.type === 'open' && d.c) {
        if (S.joined && S.channel === d.c) {
          S.pendingOpen = d.k || '';
          poll();
        } else if (S.name || els.nameInput.value.trim()) {
          if (S.joined) leave();
          S.pendingOpen = d.k || '';
          join(S.name || els.nameInput.value.trim().slice(0, 20), normalizeChannel(d.c));
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const linkChannel = normalizeChannel(params.get('c'));
  const savedName = store.get('walki:name');
  const joinedChannel = normalizeChannel(store.get('walki:joined'));
  els.nameInput.value = savedName;
  els.channelInput.value = linkChannel || store.get('walki:channel');

  // Reopen the channel you were in, so walki is always on. A link to another
  // channel shows the join screen instead.
  if (savedName && joinedChannel && (!linkChannel || linkChannel === joinedChannel)) {
    S.pendingOpen = params.get('k') || '';
    join(savedName, joinedChannel);
  } else if (savedName && linkChannel && params.get('k')) {
    S.pendingOpen = params.get('k');
    join(savedName, linkChannel);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('sw', err));
  }
})();
