'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS) || 16;
const MAX_TALK_MS = Number(process.env.MAX_TALK_MS) || 60_000;
const HEARTBEAT_MS = 15_000;

// ICE servers handed to every client. A TURN server is strongly recommended
// for cellular / corporate networks where direct peer connections fail.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  });
}

// When the app is hosted elsewhere (e.g. Vercel), only accept sockets from those
// origins. Comma-separated; `*` matches one subdomain label, e.g.
// https://walki.vercel.app,https://walki-*.vercel.app
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean)
  .map((o) => new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i'));

function originAllowed(origin, host) {
  if (!ALLOWED_ORIGINS.length || !origin) return true;
  try {
    if (new URL(origin).host === host) return true;
  } catch {
    return false;
  }
  return ALLOWED_ORIGINS.some((re) => re.test(origin));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  let file;
  try {
    file = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (!file || file.endsWith('/')) file += 'index.html';
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }

  fs.stat(full, (err, stat) => {
    // Unknown paths fall back to the app shell so share links always open.
    const target = !err && stat.isFile() ? full : path.join(PUBLIC, 'index.html');
    const ext = path.extname(target);
    const isShell = ext === '.html' || target.endsWith('sw.js') || ext === '.webmanifest';
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': isShell ? 'no-cache' : 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'permissions-policy': 'microphone=(self)',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// Optional local HTTPS (needed for microphone access on phones over a LAN).
const keyPath = process.env.SSL_KEY || path.join(__dirname, 'certs', 'key.pem');
const certPath = process.env.SSL_CERT || path.join(__dirname, 'certs', 'cert.pem');
const useTls = fs.existsSync(keyPath) && fs.existsSync(certPath);
const server = useTls
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, serveStatic)
  : http.createServer(serveStatic);

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** @type {Map<string, {members: Map<string, any>, talker: string|null, timer: any}>} */
const channels = new Map();

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

function broadcast(channel, msg, exceptId) {
  for (const [id, ws] of channel.members) if (id !== exceptId) send(ws, msg);
}

function setTalker(channel, id) {
  clearTimeout(channel.timer);
  channel.talker = id;
  if (id) channel.timer = setTimeout(() => setTalker(channel, null), MAX_TALK_MS);
  broadcast(channel, { t: 'floor', talker: id });
}

function leave(ws) {
  const channel = channels.get(ws.channel);
  if (!channel || !channel.members.has(ws.id)) return;
  channel.members.delete(ws.id);
  broadcast(channel, { t: 'peer-leave', id: ws.id });
  if (channel.talker === ws.id) setTalker(channel, null);
  if (channel.members.size === 0) {
    clearTimeout(channel.timer);
    channels.delete(ws.channel);
  }
  ws.channel = null;
}

const clean = (s, max) => String(s || '').trim().slice(0, max);

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => originAllowed(origin, req.headers.host),
});

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const channel = channels.get(ws.channel);

    switch (msg.t) {
      case 'join': {
        if (ws.channel) leave(ws);
        const name = clean(msg.name, 20) || 'Guest';
        const key = clean(msg.channel, 24).toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!key) return send(ws, { t: 'error', code: 'channel' });

        let ch = channels.get(key);
        if (!ch) channels.set(key, (ch = { members: new Map(), talker: null, timer: null }));
        if (ch.members.size >= MAX_MEMBERS) return send(ws, { t: 'error', code: 'full' });

        ws.name = name;
        ws.channel = key;
        const peers = [...ch.members.values()].map((m) => ({ id: m.id, name: m.name }));
        ch.members.set(ws.id, ws);
        send(ws, { t: 'welcome', id: ws.id, channel: key, peers, talker: ch.talker, iceServers: ICE_SERVERS });
        broadcast(ch, { t: 'peer-join', peer: { id: ws.id, name } }, ws.id);
        break;
      }

      case 'signal': {
        const target = channel && channel.members.get(msg.to);
        if (target) send(target, { t: 'signal', from: ws.id, data: msg.data });
        break;
      }

      case 'talk': {
        if (!channel) return;
        if (!channel.talker || channel.talker === ws.id) setTalker(channel, ws.id);
        else send(ws, { t: 'busy', talker: channel.talker });
        break;
      }

      case 'release': {
        if (channel && channel.talker === ws.id) setTalker(channel, null);
        break;
      }

      case 'leave':
        leave(ws);
        break;

      case 'ping':
        send(ws, { t: 'pong' });
        break;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Drop dead sockets quickly so a vanished talker never holds the channel.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`walki running on ${useTls ? 'https' : 'http'}://localhost:${PORT}`);
});
