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

  const S = {
    ws: null,
    myId: null,
    name: '',
    channel: '',
    joined: false,
    iceServers: [],
    stream: null,
    track: null,
    members: new Map(), // id -> name
    peers: new Map(), // id -> { id, pc, audio, queue, initiator, tuned }
    talker: null,
    pressing: false,
    tx: false,
    txStart: 0,
    state: 'idle',
    level: 0,
    raf: 0,
    retry: 0,
    connected: false,
    retryTimer: 0,
    lastSeen: 0,
    signalChain: Promise.resolve(),
    ctx: null,
    micAnalyser: null,
    micBuf: null,
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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    track.enabled = false;
    if ('contentHint' in track) track.contentHint = 'speech';
    track.addEventListener('ended', () => {
      if (S.joined) {
        toast('Microphone disconnected');
        leave();
      }
    });
    S.stream = stream;
    S.track = track;

    if (S.ctx) {
      try {
        const an = S.ctx.createAnalyser();
        an.fftSize = 512;
        S.ctx.createMediaStreamSource(stream).connect(an);
        S.micAnalyser = an;
        S.micBuf = new Float32Array(an.fftSize);
      } catch {}
    }
  }

  function closeMic() {
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
    S.track = null;
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
      default:
        return 'Could not start the microphone';
    }
  }

  // -------------------------------------------------------------------------
  // Signalling socket
  // -------------------------------------------------------------------------
  // Set by config.js when the signalling server lives on another host (e.g. app on
  // Vercel, server on Render). Otherwise the server that served the page is used.
  const SIGNAL_URL = window.WALKI_SIGNAL_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const send = (msg) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify(msg));

  function connect() {
    clearTimeout(S.retryTimer);
    dropSocket(false);
    const ws = new WebSocket(SIGNAL_URL);
    S.ws = ws;
    S.lastSeen = Date.now();
    ws.onopen = () => send({ t: 'join', channel: S.channel, name: S.name });
    ws.onmessage = (e) => {
      S.lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => {
      if (S.ws === ws) dropSocket(true);
    };
  }

  function dropSocket(reconnect) {
    const ws = S.ws;
    S.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      try { ws.close(); } catch {}
    }
    if (!reconnect) return;

    teardownPeers();
    S.members.clear();
    S.myId = null;
    if (S.tx) stopTx(false);
    S.pressing = false;
    S.talker = null;
    setOffline(true);
    render();
    if (S.joined) {
      const delay = Math.min(8000, 400 * 2 ** S.retry++);
      S.retryTimer = setTimeout(connect, delay);
    }
  }

  // App-level keepalive: detects silently dead sockets (e.g. Wi-Fi -> cellular).
  setInterval(() => {
    if (!S.joined || !S.ws) return;
    if (S.ws.readyState === 1) send({ t: 'ping' });
    if (Date.now() - S.lastSeen > 25000) dropSocket(true);
  }, 10000);

  function handle(msg) {
    switch (msg.t) {
      case 'welcome':
        S.retry = 0;
        S.connected = true;
        S.myId = msg.id;
        S.iceServers = msg.iceServers || [];
        setOffline(false);
        for (const p of msg.peers) {
          S.members.set(p.id, p.name);
          createPeer(p.id, true);
        }
        setTalker(msg.talker);
        render();
        break;

      case 'peer-join':
        S.members.set(msg.peer.id, msg.peer.name);
        render();
        break;

      case 'peer-leave':
        S.members.delete(msg.id);
        closePeer(msg.id);
        render();
        break;

      case 'signal':
        S.signalChain = S.signalChain.then(() => onSignal(msg.from, msg.data)).catch((e) => console.warn('signal', e));
        break;

      case 'floor':
        setTalker(msg.talker);
        break;

      case 'busy':
        S.pressing = false;
        deny();
        render();
        break;

      case 'error':
        leave();
        showJoinError(msg.code === 'full' ? 'That channel is full' : 'Choose a different channel name');
        break;
    }
  }

  // -------------------------------------------------------------------------
  // WebRTC mesh
  // -------------------------------------------------------------------------

  // Opus tuned for speech: in-band FEC for packet loss, mono, 32 kbps fullband.
  function tuneSdp(sdp) {
    const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
    if (!m) return sdp;
    const pt = m[1];
    const want = {
      minptime: 10,
      useinbandfec: 1,
      usedtx: 0,
      stereo: 0,
      'sprop-stereo': 0,
      maxplaybackrate: 48000,
      maxaveragebitrate: 32000,
    };
    const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    const merge = (existing) => {
      const params = new Map(
        existing.split(';').map((kv) => kv.trim().split('=')).filter(([k]) => k)
      );
      for (const [k, v] of Object.entries(want)) params.set(k, String(v));
      return `a=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
    };
    return re.test(sdp) ? sdp.replace(re, (_, p) => merge(p)) : sdp.replace(m[0], `${m[0]}\r\n${merge('')}`);
  }

  function tuneSender(peer) {
    if (peer.tuned) return;
    peer.tuned = true;
    for (const sender of peer.pc.getSenders()) {
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) continue;
        p.encodings[0].maxBitrate = 40000;
        p.encodings[0].priority = 'high';
        p.encodings[0].networkPriority = 'high';
        sender.setParameters(p).catch(() => {});
      } catch {}
    }
  }

  function createPeer(id, initiator) {
    closePeer(id);
    const pc = new RTCPeerConnection({ iceServers: S.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const peer = { id, pc, audio: null, queue: [], initiator, tuned: false };
    S.peers.set(id, peer);

    pc.addTrack(S.track, S.stream);
    pc.onicecandidate = (e) => e.candidate && send({ t: 'signal', to: id, data: { candidate: e.candidate } });
    pc.ontrack = (e) => attachAudio(peer, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') tuneSender(peer);
      if (st === 'failed' && peer.initiator) makeOffer(peer, true);
      renderMembers();
    };

    if (initiator) makeOffer(peer);
    return peer;
  }

  async function makeOffer(peer, iceRestart = false) {
    try {
      const offer = await peer.pc.createOffer({ iceRestart });
      offer.sdp = tuneSdp(offer.sdp);
      await peer.pc.setLocalDescription(offer);
      send({ t: 'signal', to: peer.id, data: { sdp: peer.pc.localDescription } });
    } catch (e) {
      console.warn('offer', e);
    }
  }

  async function onSignal(from, data) {
    let peer = S.peers.get(from);
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (!peer) peer = createPeer(from, false);
        await peer.pc.setRemoteDescription(data.sdp);
        const answer = await peer.pc.createAnswer();
        answer.sdp = tuneSdp(answer.sdp);
        await peer.pc.setLocalDescription(answer);
        send({ t: 'signal', to: from, data: { sdp: peer.pc.localDescription } });
      } else if (peer) {
        await peer.pc.setRemoteDescription(data.sdp);
      }
      if (peer) for (const c of peer.queue.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate && peer) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.queue.push(data.candidate);
    }
  }

  function attachAudio(peer, stream) {
    if (!peer.audio) {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.playsInline = true;
      a.setAttribute('playsinline', '');
      a.hidden = true;
      body.appendChild(a);
      peer.audio = a;
    }
    peer.audio.srcObject = stream;
    peer.audio.muted = S.talker !== peer.id;
    peer.audio.play().catch(() => {});
  }

  function closePeer(id) {
    const peer = S.peers.get(id);
    if (!peer) return;
    S.peers.delete(id);
    peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
    try { peer.pc.close(); } catch {}
    if (peer.audio) {
      peer.audio.srcObject = null;
      peer.audio.remove();
    }
  }

  function teardownPeers() {
    for (const id of [...S.peers.keys()]) closePeer(id);
  }

  // -------------------------------------------------------------------------
  // Push-to-talk / floor control
  // -------------------------------------------------------------------------
  function setTalker(id) {
    const prev = S.talker;
    S.talker = id || null;

    for (const p of S.peers.values()) if (p.audio) p.audio.muted = p.id !== S.talker;

    if (S.talker && S.talker === S.myId) {
      if (S.pressing && !S.tx) startTx();
      else if (!S.pressing) send({ t: 'release' });
    } else if (S.tx) {
      stopTx(false);
      S.pressing = false;
      toast('Time limit reached');
    }

    if (prev !== S.talker) {
      if (S.talker && S.talker !== S.myId) sfx.rxStart();
      else if (prev && prev !== S.myId) sfx.rxEnd();
    }
    render();
  }

  function press() {
    if (S.pressing || !S.myId || !S.track) return;
    unlockAudio();
    haptic(10);
    if (S.talker && S.talker !== S.myId) return deny();
    S.pressing = true;
    send({ t: 'talk' });
    render();
  }

  function release() {
    if (!S.pressing) return;
    S.pressing = false;
    if (S.tx) stopTx(true);
    else send({ t: 'release' });
    render();
  }

  function startTx() {
    S.tx = true;
    S.txStart = Date.now();
    S.track.enabled = true;
    sfx.txStart();
    haptic(18);
  }

  function stopTx(notify) {
    S.tx = false;
    if (S.track) S.track.enabled = false;
    sfx.txEnd();
    if (notify) send({ t: 'release' });
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
    const list = [{ key: 'self', name: S.name, me: true, talking: S.tx, linked: true }];
    for (const [id, name] of S.members) {
      const pc = S.peers.get(id);
      list.push({ key: id, name, me: false, talking: S.talker === id, linked: pc && pc.pc.connectionState === 'connected' });
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
      el.style.opacity = m.linked ? '' : '.45';
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
    else if (S.talker && S.talker !== S.myId) state = 'rx';
    else if (S.pressing) state = 'pending';
    S.state = state;
    body.dataset.state = state;
    els.pttWrap.classList.toggle('rx-tone', state === 'rx');

    const others = S.members.size;
    if (offline) {
      els.statusText.textContent = S.connected ? 'Reconnecting…' : 'Connecting…';
      setCaption('Hold to talk', 'Waiting for connection');
    } else {
      els.statusText.textContent = others ? `${others + 1} on channel` : 'Only you here';
      if (state === 'tx') setCaption('Talking', `Release to listen · ${fmtTime(Date.now() - S.txStart)}`);
      else if (state === 'rx') setCaption(S.members.get(S.talker) || 'Someone', 'is talking');
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
    let raw = 0;
    if (S.state === 'tx' && S.micAnalyser) {
      S.micAnalyser.getFloatTimeDomainData(S.micBuf);
      let sum = 0;
      for (let i = 0; i < S.micBuf.length; i++) sum += S.micBuf[i] * S.micBuf[i];
      raw = Math.sqrt(sum / S.micBuf.length);
      const sec = Math.floor((Date.now() - S.txStart) / 1000);
      if (sec !== lastSecond) {
        lastSecond = sec;
        els.captionSub.textContent = `Release to listen · ${fmtTime(Date.now() - S.txStart)}`;
      }
    } else if (S.state === 'rx') {
      const peer = S.peers.get(S.talker);
      const rec = peer && peer.pc.getReceivers()[0];
      const src = rec && rec.getSynchronizationSources && rec.getSynchronizationSources()[0];
      raw = (src && src.audioLevel) || 0;
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

    S.name = name;
    S.channel = channel;
    S.joined = true;
    S.retry = 0;
    S.connected = false;
    store.set('walki:name', name);
    store.set('walki:channel', channel);
    history.replaceState(null, '', `/?c=${encodeURIComponent(channel)}`);

    els.channelName.textContent = `#${channel}`;
    setOffline(true);
    render();
    showScreen('radio');
    keepAwake();
    connect();
  });

  function leave() {
    if (!S.joined) return;
    release();
    S.joined = false;
    clearTimeout(S.retryTimer);
    send({ t: 'leave' });
    dropSocket(false);
    teardownPeers();
    S.members.clear();
    S.myId = null;
    S.talker = null;
    S.tx = false;
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
    for (const p of S.peers.values()) if (p.audio) p.audio.play().catch(() => {});
    if (!S.ws) connect();
    else if (S.ws.readyState === 1) send({ t: 'ping' });
  });

  window.addEventListener('online', () => {
    if (S.joined && !S.ws) connect();
  });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  els.nameInput.value = store.get('walki:name');
  els.channelInput.value = normalizeChannel(params.get('c') || store.get('walki:channel'));

  // Wake a sleeping server (e.g. Render free plan) while the user is still typing.
  if (window.WALKI_SIGNAL_URL) {
    fetch(SIGNAL_URL.replace(/^ws/, 'http').replace(/\/ws$/, '/healthz'), { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
  }

  if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
