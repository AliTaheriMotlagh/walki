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
    shareBtn: $('shareBtn'),
    channelName: $('channelName'),
    statusText: $('statusText'),
    pttWrap: $('pttWrap'),
    ptt: $('ptt'),
    caption: document.querySelector('.caption'),
    captionMain: $('captionMain'),
    captionSub: $('captionSub'),
    members: $('members'),
    toast: $('toast'),
    haptic: $('haptic'),
  };

  const POLL_MS = 1500;
  const POLL_HIDDEN_MS = 4000;
  const MAX_TALK_MS = 60_000;
  const MIN_CLIP_MS = 350; // shorter presses are treated as accidental
  const CLIP_RATE = 8000; // clips are 8 kHz mu-law, ~8 KB per second of speech

  const S = {
    myId: null,
    name: '',
    channel: '',
    joined: false,
    connected: false,
    failures: 0,
    pollTimer: 0,
    pollSeq: 0,
    stream: null,
    track: null,
    mic: null, // { src, rec, mute } audio graph for the open microphone
    chunks: [], // Float32Array chunks of the current recording
    recDone: null,
    members: new Map(), // id -> name
    talker: null, // someone else holding the floor (recording right now)
    heard: new Set(), // clip ids already seen
    queue: [], // clips waiting to play
    playing: null, // clip being played
    sending: 0,
    pressing: false,
    flow: false, // a transmission is in progress (press -> recording stopped)
    tx: false,
    txStart: 0,
    txTimer: 0,
    state: 'idle',
    level: 0,
    levelBuf: new Float32Array(512),
    raf: 0,
    ctx: null,
    micAnalyser: null,
    rxAnalyser: null,
    recReady: null,
    wakeLock: null,
  };

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
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

  let toastTimer = 0;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function haptic(pattern = 12) {
    if (navigator.vibrate) navigator.vibrate(pattern);
    else els.haptic.click(); // iOS 18+: toggling a switch input gives a light tap
  }

  // -------------------------------------------------------------------------
  // Audio: context, sound cues, microphone
  // -------------------------------------------------------------------------
  function unlockAudio() {
    if (!S.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      S.ctx = new Ctx({ latencyHint: 'interactive' });
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
    if (!ctx || ctx.state !== 'running') return;
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
    if (!ctx || ctx.state !== 'running') return;
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
  };

  async function openMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
    }
    if (!S.ctx || !S.ctx.audioWorklet) throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    try {
      if (!S.recReady) S.recReady = S.ctx.audioWorklet.addModule('/recorder.js');
      await S.recReady;
    } catch {
      S.recReady = null;
      stream.getTracks().forEach((t) => t.stop());
      throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    }

    const track = stream.getAudioTracks()[0];
    if ('contentHint' in track) track.contentHint = 'speech';
    track.addEventListener('ended', () => {
      if (S.joined) {
        toast('Microphone disconnected');
        leave();
      }
    });
    S.stream = stream;
    S.track = track;

    // mic -> analyser (level meter) and -> recorder worklet -> muted output.
    // The worklet only runs while connected towards the destination.
    const src = S.ctx.createMediaStreamSource(stream);
    const rec = new AudioWorkletNode(S.ctx, 'walki-rec');
    const mute = S.ctx.createGain();
    mute.gain.value = 0;
    const an = S.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    src.connect(rec).connect(mute).connect(S.ctx.destination);
    rec.port.onmessage = (e) => {
      if (e.data) S.chunks.push(e.data);
      else if (S.recDone) S.recDone();
    };
    S.mic = { src, rec, mute };
    S.micAnalyser = an;
  }

  function closeMic() {
    if (S.mic) {
      for (const node of Object.values(S.mic)) try { node.disconnect(); } catch {}
      S.mic.rec.port.onmessage = null;
    }
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
    S.track = null;
    S.mic = null;
    S.micAnalyser = null;
  }

  function micError(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Allow microphone access to join';
      case 'NotFoundError':
        return 'No microphone found';
      case 'InsecureContext':
        return 'Open walki over HTTPS to use the microphone';
      case 'Unsupported':
        return 'This browser can’t record audio. Update it or try another one';
      default:
        return 'Could not start the microphone';
    }
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
      const b = Math.floor((i + 1) * step);
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

  function stopRecording() {
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        clearTimeout(timer);
        S.recDone = null;
        const pcm = concat(S.chunks);
        S.chunks = [];
        resolve(pcm);
      };
      timer = setTimeout(done, 500); // the worklet can't answer while audio is suspended
      S.recDone = done;
      if (S.mic) S.mic.rec.port.postMessage(false);
      else done();
    });
  }

  // -------------------------------------------------------------------------
  // Server: plain HTTPS requests, polled
  // -------------------------------------------------------------------------
  function api(action, { method = 'GET', params = {}, body, timeout = 10000 } = {}) {
    const q = new URLSearchParams({ c: S.channel, id: S.myId, name: S.name, ...params });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(`/api/${action}?${q}`, {
      method,
      body,
      cache: 'no-store',
      signal: ctrl.signal,
      headers: body ? { 'content-type': 'application/octet-stream' } : undefined,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!data) throw new Error(`HTTP ${res.status}`);
        return data;
      })
      .finally(() => clearTimeout(timer));
  }

  async function poll() {
    clearTimeout(S.pollTimer);
    if (!S.joined) return;
    const seq = ++S.pollSeq;
    try {
      const r = await api('poll');
      if (!S.joined || seq !== S.pollSeq) return;
      if (r.error === 'full' || r.error === 'storage') {
        leave();
        return showJoinError(r.error === 'full' ? 'That channel is full' : 'walki’s server storage isn’t set up yet');
      }
      if (r.error) throw new Error(r.error);
      onState(r);
    } catch (err) {
      if (!S.joined || seq !== S.pollSeq) return;
      console.warn('poll', err);
      if (++S.failures >= 2) setOffline(true);
      render();
    }
    S.pollTimer = setTimeout(poll, document.visibilityState === 'visible' ? POLL_MS : POLL_HIDDEN_MS);
  }

  function onState(r) {
    const first = !S.connected;
    S.connected = true;
    S.failures = 0;
    setOffline(false);

    S.members = new Map(r.members.map((m) => [m.id, m.name]));
    if (!S.flow) S.talker = r.talker && r.talker !== S.myId ? r.talker : null;

    // Play clips that arrived since the last poll; on joining, skip the backlog.
    for (const clip of r.clips) {
      if (first || S.heard.has(clip.k) || clip.from === S.myId) continue;
      enqueue(clip);
    }
    S.heard = new Set(r.clips.map((c) => c.k));
    render();
  }

  function sendLeave() {
    const url = `/api/leave?${new URLSearchParams({ c: S.channel, id: S.myId })}`;
    if (!(navigator.sendBeacon && navigator.sendBeacon(url))) fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Playback queue
  // -------------------------------------------------------------------------
  function enqueue(clip) {
    clip.data = fetch(`/api/clip?${new URLSearchParams({ c: S.channel, k: clip.k })}`)
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .catch(() => null);
    S.queue.push(clip);
    playNext();
  }

  async function playNext() {
    if (S.playing || S.flow || !S.queue.length || !S.ctx) return;
    const clip = S.queue.shift();
    S.playing = clip;
    render();
    const data = await clip.data;
    if (S.playing !== clip) return; // left or stopped meanwhile
    if (!data || !data.byteLength) {
      S.playing = null;
      render();
      return playNext();
    }

    if (S.ctx.state !== 'running') S.ctx.resume().catch(() => {});
    const src = S.ctx.createBufferSource();
    src.buffer = decodeClip(new Uint8Array(data));
    const an = S.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an).connect(S.ctx.destination);
    clip.src = src;
    S.rxAnalyser = an;
    src.onended = () => {
      if (S.playing !== clip) return;
      S.playing = null;
      S.rxAnalyser = null;
      sfx.rxEnd();
      render();
      playNext();
    };
    sfx.rxStart();
    src.start(S.ctx.currentTime + 0.08);
    render();
  }

  function stopPlayback() {
    const clip = S.playing;
    S.playing = null;
    S.queue = [];
    S.rxAnalyser = null;
    if (clip && clip.src) {
      clip.src.onended = null;
      try { clip.src.stop(); } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // Push-to-talk / floor control
  // -------------------------------------------------------------------------

  // Recording starts on touch so no words are lost while the server grants the floor.
  async function press() {
    if (S.pressing || S.flow || !S.connected || !S.mic) return;
    unlockAudio();
    haptic(10);
    if (S.playing || S.talker) return deny();
    S.pressing = S.flow = true;
    S.chunks = [];
    S.txStart = Date.now();
    S.mic.rec.port.postMessage(true);
    render();

    const res = await api('talk', { method: 'POST' }).catch(() => ({ error: 'network' }));
    if (!res.ok) {
      await stopRecording();
      S.pressing = S.flow = false;
      if (res.busy) {
        S.talker = res.busy;
        deny();
      } else {
        toast('Could not reach walki');
      }
      render();
      return playNext();
    }

    S.tx = true;
    sfx.txStart();
    haptic(18);
    S.txTimer = setTimeout(() => {
      toast('Time limit reached');
      release();
    }, MAX_TALK_MS - (Date.now() - S.txStart));
    if (!S.pressing) finishTx(); // let go before the floor was granted
    render();
  }

  function release() {
    if (!S.pressing) return;
    S.pressing = false;
    if (S.tx) finishTx();
    render();
  }

  async function finishTx() {
    clearTimeout(S.txTimer);
    S.tx = false;
    const ms = Date.now() - S.txStart;
    const pcm = await stopRecording();
    S.flow = false;
    sfx.txEnd();
    render();
    playNext();

    if (!S.joined || ms < MIN_CLIP_MS || !pcm.length) {
      api('release', { method: 'POST' }).catch(() => {});
      return;
    }
    S.sending++;
    render();
    try {
      const body = encodeClip(pcm, S.ctx.sampleRate);
      const r = await api('clip', { method: 'POST', params: { ms: String(ms) }, body, timeout: 30000 });
      if (!r.ok) throw new Error(r.error);
    } catch (err) {
      console.warn('clip', err);
      toast('Message not sent');
      api('release', { method: 'POST' }).catch(() => {});
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

  // Pointer (touch, pen, mouse)
  els.ptt.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { els.ptt.setPointerCapture(e.pointerId); } catch {}
    press();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) els.ptt.addEventListener(ev, release);
  els.ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  els.ptt.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  // Keyboard: hold Space (or Enter on the focused button)
  const isTyping = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
  window.addEventListener('keydown', (e) => {
    if (body.dataset.screen !== 'radio' || isTyping() || e.repeat) return;
    if (e.code === 'Space' || (e.key === 'Enter' && document.activeElement === els.ptt)) {
      e.preventDefault();
      press();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.key === 'Enter') release();
  });
  window.addEventListener('blur', release);

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  const memberEls = new Map();

  function renderMembers() {
    const list = [{ key: 'self', name: S.name, me: true, talking: S.tx }];
    for (const [id, name] of S.members) {
      list.push({ key: id, name, me: false, talking: S.talker === id || (S.playing && S.playing.from === id) });
    }

    const seen = new Set();
    for (const m of list) {
      seen.add(m.key);
      let el = memberEls.get(m.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'member';
        el.innerHTML = '<div class="avatar"></div><div class="member-name"></div>';
        els.members.appendChild(el);
        memberEls.set(m.key, el);
      }
      el.querySelector('.avatar').textContent = initials(m.name);
      el.querySelector('.member-name').textContent = m.me ? 'You' : m.name;
      el.classList.toggle('me', m.me);
      el.classList.toggle('talking', !!m.talking);
      el.title = m.name;
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
    els.captionSub.textContent = sub;
  }

  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function render() {
    const offline = body.classList.contains('offline');
    let state = 'idle';
    if (S.tx) state = 'tx';
    else if (S.pressing) state = 'pending';
    else if (S.playing || S.talker) state = 'rx';
    S.state = state;
    body.dataset.state = state;
    els.pttWrap.classList.toggle('rx-tone', state === 'rx');

    const others = S.members.size;
    if (offline) {
      els.statusText.textContent = S.connected ? 'Reconnecting…' : 'Connecting…';
      setCaption('Hold to talk', 'Waiting for connection');
    } else {
      els.statusText.textContent = others ? `${others + 1} on channel` : 'Only you here';
      if (state === 'tx') setCaption('Talking', `Release to send · ${fmtTime(Date.now() - S.txStart)}`);
      else if (state === 'rx' && S.playing) setCaption(S.playing.name, 'is talking');
      else if (state === 'rx') setCaption(S.members.get(S.talker) || 'Someone', 'is talking · plays when they let go');
      else if (S.sending) setCaption('Hold to talk', 'Sending…');
      else setCaption('Hold to talk', others ? 'Channel is clear' : 'Invite someone to start talking');
    }
    els.ptt.setAttribute('aria-pressed', String(state === 'tx'));
    els.ptt.setAttribute('aria-label', state === 'rx' ? 'Channel busy' : 'Hold to talk');

    renderMembers();
    if ((state === 'tx' || state === 'rx') && !S.raf) S.raf = requestAnimationFrame(meter);
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
    const target = Math.min(1, Math.sqrt(raw) * 1.6);
    S.level += (target - S.level) * (target > S.level ? 0.45 : 0.12);
    els.pttWrap.style.setProperty('--level', S.level.toFixed(3));
    S.raf = requestAnimationFrame(meter);
  }

  function setOffline(off) {
    body.classList.toggle('offline', off);
  }

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

  els.joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.nameInput.value.trim().slice(0, 20);
    const channel = normalizeChannel(els.channelInput.value);
    if (!name) return showJoinError('Enter your name', els.nameInput);
    if (!channel) return showJoinError('Enter a channel name', els.channelInput);
    showJoinError('');
    document.activeElement && document.activeElement.blur();

    unlockAudio(); // must run inside the tap
    setLoading(true);
    try {
      await openMic();
    } catch (err) {
      setLoading(false);
      return showJoinError(micError(err));
    }
    setLoading(false);

    S.myId = newId();
    S.name = name;
    S.channel = channel;
    S.joined = true;
    S.connected = false;
    S.failures = 0;
    S.heard = new Set();
    store.set('walki:name', name);
    store.set('walki:channel', channel);
    history.replaceState(null, '', `/?c=${encodeURIComponent(channel)}`);

    els.channelName.textContent = `#${channel}`;
    setOffline(true);
    render();
    showScreen('radio');
    keepAwake();
    poll();
  });

  function leave() {
    if (!S.joined) return;
    release();
    S.joined = false;
    S.pollSeq++;
    clearTimeout(S.pollTimer);
    sendLeave();
    stopPlayback();
    S.members.clear();
    S.talker = null;
    S.connected = false;
    closeMic();
    if (S.wakeLock) S.wakeLock.release().catch(() => {});
    setOffline(false);
    render();
    showScreen('join');
  }
  els.leaveBtn.addEventListener('click', leave);

  els.shareBtn.addEventListener('click', async () => {
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
  });

  // -------------------------------------------------------------------------
  // Lifecycle: stay awake, recover after sleep / network changes
  // -------------------------------------------------------------------------
  async function keepAwake() {
    if (!('wakeLock' in navigator) || S.wakeLock || document.visibilityState !== 'visible') return;
    try {
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wakeLock.addEventListener('release', () => (S.wakeLock = null));
    } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return release();
    if (!S.joined) return;
    keepAwake();
    if (S.ctx && S.ctx.state !== 'running') S.ctx.resume().catch(() => {});
    poll();
  });

  window.addEventListener('online', poll);
  window.addEventListener('pagehide', () => S.joined && sendLeave());
  window.addEventListener('pageshow', (e) => e.persisted && poll());

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  els.nameInput.value = store.get('walki:name');
  els.channelInput.value = normalizeChannel(params.get('c') || store.get('walki:channel'));

  if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
