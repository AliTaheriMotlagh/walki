'use strict';

// Channel logic over plain HTTP, shared by the Vercel function (api/[action].js)
// and the local dev server (server.js).
//
// - Open apps poll for channel state while they are on screen.
// - A transmission is recorded on the talker's device and uploaded as one clip
//   when they let go. Photos (dual camera) are uploaded the same way.
// - Devices that are not on screen get a Web Push notification instead of
//   polling, so phones can sleep and the free plans go a long way.
//
// State lives in Upstash Redis (Vercel Marketplace -> Upstash for Redis sets
// KV_REST_API_URL / KV_REST_API_TOKEN). Without it an in-memory store is used,
// which only works inside a single process (local dev).

const crypto = require('crypto');
const webpush = require('web-push');

let waitUntil = (p) => p;
try {
  ({ waitUntil } = require('@vercel/functions'));
} catch {}

const MAX_MEMBERS = Number(process.env.MAX_MEMBERS) || 16; // on screen at once
const MAX_SUBS = 64; // devices getting background alerts per channel
const MAX_TALK_MS = Number(process.env.MAX_TALK_MS) || 60_000;
const FLOOR_MS = MAX_TALK_MS + 15_000; // also covers the upload after release
const STALE_MS = 15_000; // a member who hasn't polled for this long is gone (or away)
const LIVE_MS = 10_000; // polled on screen this recently: no push needed
const CLIP_TTL_S = 24 * 3600; // missed messages stay on the server for a day
const KEEP_CLIPS = 50;
const MEMBERS_TTL_S = 3600;
const SUB_TTL_MS = 14 * 24 * 3600 * 1000; // forget alert subscriptions unused for 2 weeks
const CLIP_RATE = 8000; // 8 kHz mu-law: 1 byte per sample
const MAX_VOICE_BYTES = CLIP_RATE * (MAX_TALK_MS / 1000 + 5);
const MAX_PHOTO_BYTES = 1_200_000;

const ID_RE = /^[a-z0-9-]{8,40}$/i;
const clean = (s, max) => String(s || '').replace(/[|\u0000-\u001f]/g, '').trim().slice(0, max);
const channelKey = (s) => clean(s, 24).toLowerCase().replace(/[^a-z0-9-]/g, '');

// ---------------------------------------------------------------------------
// Stores. Both expose the same async API:
//   poll(c, id, name, now, vis) -> { members, away, talker, clips } | 'full'
//   talk(c, id, now)            -> '' when granted, else the current talker's id
//   release(c, id, mode)        mode: 'release' | 'away' | 'leave'
//   addClip(c, id, meta, bytes, now) -> [{ id, sub }] devices to alert
//   getClip(c, k)               -> Buffer | null
//   subscribe(c, id, name, sub, now) -> boolean
//   unsubscribe(c, id)
//   vapid()                     -> { publicKey, privateKey }
//
// Members hash value: "<seen ms>|<1 on screen, 0 hidden>|<name>"
// Subscriber names hash value: "<refreshed ms>|<name>"
// ---------------------------------------------------------------------------

// Each operation is one Lua script, so it is atomic and a single Redis command.
const POLL_LUA = `
local m, f, c, s, p = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local id, name, now, stale, max, ttl, vis, subttl = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), ARGV[6], ARGV[7], tonumber(ARGV[8])
local all = redis.call('HGETALL', m)
local live, here, known = {}, {}, false
for i = 1, #all, 2 do
  local v = all[i + 1]
  local a = string.find(v, '|', 1, true)
  local b = a and string.find(v, '|', a + 1, true)
  if not b or now - tonumber(string.sub(v, 1, a - 1)) > stale then
    redis.call('HDEL', m, all[i])
  elseif all[i] == id then
    known = true
  else
    here[all[i]] = true
    live[#live + 1] = all[i]
    live[#live + 1] = string.sub(v, b + 1)
    live[#live + 1] = string.sub(v, a + 1, b - 1)
  end
end
if not known and #live / 3 + 1 > max then return 'full' end
redis.call('HSET', m, id, now .. '|' .. vis .. '|' .. name)
redis.call('EXPIRE', m, ttl)
local away = {}
local subs = redis.call('HGETALL', s)
for i = 1, #subs, 2 do
  local v = subs[i + 1]
  local a = string.find(v, '|', 1, true)
  local ts = a and tonumber(string.sub(v, 1, a - 1)) or 0
  if now - ts > subttl then
    redis.call('HDEL', s, subs[i])
    redis.call('HDEL', p, subs[i])
  elseif subs[i] == id then
    if now - ts > 3600000 then
      redis.call('HSET', s, id, now .. '|' .. name)
      redis.call('PEXPIRE', s, subttl)
      redis.call('PEXPIRE', p, subttl)
    end
  elseif not here[subs[i]] then
    away[#away + 1] = subs[i]
    away[#away + 1] = string.sub(v, a + 1)
  end
end
return {live, redis.call('GET', f) or '', redis.call('LRANGE', c, 0, -1), away}`;

const TALK_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= ARGV[1] then return cur end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return ''`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
if ARGV[2] ~= 'release' then redis.call('HDEL', KEYS[2], ARGV[1]) end
if ARGV[2] == 'leave' then
  redis.call('HDEL', KEYS[3], ARGV[1])
  redis.call('HDEL', KEYS[4], ARGV[1])
end
return 1`;

// Stores the clip, then returns the alert subscriptions of everyone who is not
// on screen right now (they will hear it live and need no notification).
const CLIP_LUA = `
local f, c, a, m, p = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local id, now, live = ARGV[1], tonumber(ARGV[6]), tonumber(ARGV[7])
redis.call('SET', a, ARGV[2], 'EX', ARGV[4])
redis.call('RPUSH', c, ARGV[3])
redis.call('LTRIM', c, -tonumber(ARGV[5]), -1)
redis.call('EXPIRE', c, ARGV[4])
if ARGV[8] == '1' and redis.call('GET', f) == id then redis.call('DEL', f) end
local watching = {}
local all = redis.call('HGETALL', m)
for i = 1, #all, 2 do
  local v = all[i + 1]
  local x = string.find(v, '|', 1, true)
  local y = x and string.find(v, '|', x + 1, true)
  if y and string.sub(v, x + 1, y - 1) == '1' and now - tonumber(string.sub(v, 1, x - 1)) <= live then
    watching[all[i]] = true
  end
end
local out = {}
local subs = redis.call('HGETALL', p)
for i = 1, #subs, 2 do
  if subs[i] ~= id and not watching[subs[i]] then
    out[#out + 1] = subs[i]
    out[#out + 1] = subs[i + 1]
  end
end
return out`;

const SUB_LUA = `
if redis.call('HLEN', KEYS[2]) >= tonumber(ARGV[5]) and redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. '|' .. ARGV[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
return 1`;

const UNSUB_LUA = `
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1`;

const keysOf = (c) => ({
  members: `w:${c}:m`,
  floor: `w:${c}:f`,
  clips: `w:${c}:c`,
  subNames: `w:${c}:s`,
  subs: `w:${c}:p`,
  audio: (k) => `w:${c}:a:${k}`,
});

function pairs(flat, step, fn) {
  const out = [];
  for (let i = 0; i < flat.length; i += step) out.push(fn(flat.slice(i, i + step)));
  return out;
}

function redisStore(url, token) {
  const call = async (cmd) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const out = await res.json();
    if (out.error) throw new Error(`redis: ${out.error}`);
    return out.result;
  };
  const run = (lua, keys, args) => call(['EVAL', lua, keys.length, ...keys, ...args.map(String)]);
  let vapidKeys = null;

  return {
    async poll(c, id, name, now, vis) {
      const k = keysOf(c);
      const r = await run(POLL_LUA, [k.members, k.floor, k.clips, k.subNames, k.subs], [
        id, name, now, STALE_MS, MAX_MEMBERS, MEMBERS_TTL_S, vis ? 1 : 0, SUB_TTL_MS,
      ]);
      if (r === 'full') return r;
      const [live, floor, clips, away] = r;
      return {
        members: pairs(live, 3, ([mid, mname, v]) => ({ id: mid, name: mname, v: v === '1' })),
        away: pairs(away, 2, ([mid, mname]) => ({ id: mid, name: mname })),
        talker: floor || null,
        clips: clips.map((s) => JSON.parse(s)),
      };
    },
    async talk(c, id) {
      return run(TALK_LUA, [keysOf(c).floor], [id, FLOOR_MS]);
    },
    async release(c, id, mode) {
      const k = keysOf(c);
      await run(RELEASE_LUA, [k.floor, k.members, k.subNames, k.subs], [id, mode]);
    },
    async addClip(c, id, meta, bytes, now) {
      const k = keysOf(c);
      const out = await run(CLIP_LUA, [k.floor, k.clips, k.audio(meta.k), k.members, k.subs], [
        id, bytes.toString('base64'), JSON.stringify(meta), CLIP_TTL_S, KEEP_CLIPS, now, LIVE_MS, meta.t === 'v' ? 1 : 0,
      ]);
      return pairs(out, 2, ([sid, sub]) => ({ id: sid, sub: JSON.parse(sub) }));
    },
    async getClip(c, clipId) {
      const b64 = await call(['GET', keysOf(c).audio(clipId)]);
      return b64 ? Buffer.from(b64, 'base64') : null;
    },
    async subscribe(c, id, name, sub, now) {
      const k = keysOf(c);
      return (await run(SUB_LUA, [k.subNames, k.subs], [id, now, name, JSON.stringify(sub), MAX_SUBS, SUB_TTL_MS])) === 1;
    },
    async unsubscribe(c, id) {
      const k = keysOf(c);
      await run(UNSUB_LUA, [k.subNames, k.subs], [id]);
    },
    // One key pair for the whole deployment, created on first use so there is
    // nothing to configure. VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY override it.
    async vapid() {
      if (vapidKeys) return vapidKeys;
      let raw = await call(['GET', 'w:vapid']);
      if (!raw) {
        await call(['SET', 'w:vapid', JSON.stringify(webpush.generateVAPIDKeys()), 'NX']);
        raw = await call(['GET', 'w:vapid']);
      }
      vapidKeys = JSON.parse(raw);
      return vapidKeys;
    },
  };
}

function memoryStore() {
  const channels = new Map();
  const get = (c) => {
    let ch = channels.get(c);
    if (!ch) {
      ch = { members: new Map(), floor: null, clips: [], audio: new Map(), subs: new Map() };
      channels.set(c, ch);
    }
    return ch;
  };
  const floorOf = (ch, now) => (ch.floor && ch.floor.until > now ? ch.floor.id : '');
  let vapidKeys = null;

  return {
    async poll(c, id, name, now, vis) {
      const ch = get(c);
      const members = [];
      for (const [mid, m] of ch.members) {
        if (now - m.seen > STALE_MS) ch.members.delete(mid);
        else if (mid !== id) members.push({ id: mid, name: m.name, v: m.vis });
      }
      if (!ch.members.has(id) && members.length + 1 > MAX_MEMBERS) return 'full';
      ch.members.set(id, { name, seen: now, vis: !!vis });
      const away = [];
      for (const [sid, s] of ch.subs) {
        if (now - s.ts > SUB_TTL_MS) ch.subs.delete(sid);
        else if (sid === id) s.ts = now;
        else if (!ch.members.has(sid)) away.push({ id: sid, name: s.name });
      }
      return { members, away, talker: floorOf(ch, now) || null, clips: ch.clips };
    },
    async talk(c, id, now) {
      const ch = get(c);
      const cur = floorOf(ch, now);
      if (cur && cur !== id) return cur;
      ch.floor = { id, until: now + FLOOR_MS };
      return '';
    },
    async release(c, id, mode) {
      const ch = get(c);
      if (ch.floor && ch.floor.id === id) ch.floor = null;
      if (mode !== 'release') ch.members.delete(id);
      if (mode === 'leave') ch.subs.delete(id);
    },
    async addClip(c, id, meta, bytes, now) {
      const ch = get(c);
      ch.audio.set(meta.k, bytes);
      ch.clips.push(meta);
      while (ch.clips.length > KEEP_CLIPS) ch.audio.delete(ch.clips.shift().k);
      if (meta.t === 'v' && ch.floor && ch.floor.id === id) ch.floor = null;
      const out = [];
      for (const [sid, s] of ch.subs) {
        const m = ch.members.get(sid);
        const watching = m && m.vis && now - m.seen <= LIVE_MS;
        if (sid !== id && !watching) out.push({ id: sid, sub: s.sub });
      }
      return out;
    },
    async getClip(c, clipId) {
      const ch = channels.get(c);
      return (ch && ch.audio.get(clipId)) || null;
    },
    async subscribe(c, id, name, sub, now) {
      const ch = get(c);
      if (ch.subs.size >= MAX_SUBS && !ch.subs.has(id)) return false;
      ch.subs.set(id, { name, sub, ts: now });
      return true;
    },
    async unsubscribe(c, id) {
      get(c).subs.delete(id);
    },
    async vapid() {
      return (vapidKeys ||= webpush.generateVAPIDKeys());
    },
  };
}

let store;
function getStore() {
  if (store !== undefined) return store;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) store = redisStore(url.replace(/\/+$/, ''), token);
  // Serverless instances don't share memory, so on Vercel Redis is required.
  else store = process.env.VERCEL ? null : memoryStore();
  return store;
}

async function vapidKeys(db) {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = process.env;
  return publicKey && privateKey ? { publicKey, privateKey } : db.vapid();
}

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------
function validSub(s) {
  return (
    s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1024 &&
    s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' &&
    s.keys.p256dh.length < 200 && s.keys.auth.length < 100
  );
}

async function notify(db, c, targets, meta, host) {
  if (!targets.length) return;
  const keys = await vapidKeys(db);
  const vapidDetails = {
    subject: process.env.VAPID_SUBJECT || `https://${host || 'walki.vercel.app'}`,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  const payload = JSON.stringify({ c, k: meta.k, n: meta.name, t: meta.t, ms: meta.ms, ts: meta.ts });
  await Promise.all(
    targets.map(({ id, sub }) =>
      webpush
        // TTL matches how long the clip is kept; the topic collapses a backlog
        // of undelivered alerts for this channel into the newest one.
        .sendNotification(sub, payload, { vapidDetails, TTL: CLIP_TTL_S, urgency: 'high', topic: c.slice(0, 32), timeout: 8000 })
        .catch((err) => {
          // The device unsubscribed or the subscription expired.
          if (err && (err.statusCode === 404 || err.statusCode === 410)) return db.unsubscribe(c, id);
          console.warn('push', err && err.statusCode, err && err.body);
        })
    )
  );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Reads the raw stream. (Don't touch req.body: on Vercel that getter parses and
// consumes the stream.)
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// GET  /api/key                   -> { key }  VAPID public key for alerts
// GET  /api/poll?c&id&name&v&since -> { members, away, talker, clips, now }
// POST /api/talk?c&id             -> { ok } | { busy: talkerId }
// POST /api/release?c&id          -> { ok }
// POST /api/away?c&id             -> { ok }   app closed or hidden (sendBeacon friendly)
// POST /api/leave?c&id            -> { ok }   left the channel, alerts off too
// POST /api/sub?c&id&name         body: PushSubscription JSON -> { ok }
// POST /api/unsub?c&id            -> { ok }
// POST /api/clip?c&id&name&ms&t   body: 8 kHz mu-law (t=v) or JPEG (t=p) -> { ok, k, ts }
// GET  /api/clip?c&k              -> the clip's bytes
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = (req.query && req.query.action) || url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const q = url.searchParams;

  const db = getStore();
  if (!db) return json(res, 503, { error: 'storage' });

  try {
    if (action === 'key') return json(res, 200, { key: (await vapidKeys(db)).publicKey });

    const c = channelKey(q.get('c'));
    if (!c) return json(res, 400, { error: 'channel' });

    if (action === 'clip' && req.method === 'GET') {
      const k = q.get('k') || '';
      if (!ID_RE.test(k)) return json(res, 400, { error: 'clip' });
      const data = await db.getClip(c, k);
      if (!data) return json(res, 404, { error: 'gone' });
      // Clips never change, so the CDN can serve every listener after the first.
      res.writeHead(200, {
        'content-type': isJpeg(data) ? 'image/jpeg' : 'application/octet-stream',
        'cache-control': `public, max-age=${CLIP_TTL_S}, s-maxage=${CLIP_TTL_S}, immutable`,
      });
      return res.end(data);
    }

    const id = q.get('id') || '';
    if (!ID_RE.test(id)) return json(res, 400, { error: 'id' });
    const name = clean(q.get('name'), 20) || 'Guest';
    const now = Date.now();

    if (action === 'poll') {
      const r = await db.poll(c, id, name, now, q.get('v') !== '0');
      if (r === 'full') return json(res, 409, { error: 'full' });
      // Only send clips the device may not have yet (with slack for clock skew
      // between server instances); it de-duplicates by key.
      const since = Number(q.get('since')) || 0;
      if (since) r.clips = r.clips.filter((m) => m.ts > since - 15_000);
      r.now = now;
      return json(res, 200, r);
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });

    switch (action) {
      case 'talk': {
        const holder = await db.talk(c, id, now);
        return json(res, 200, holder ? { busy: holder } : { ok: true });
      }
      case 'release':
      case 'away':
      case 'leave':
        await db.release(c, id, action);
        return json(res, 200, { ok: true });
      case 'sub': {
        const raw = await readBody(req, 4096);
        let sub = null;
        try { sub = raw && JSON.parse(raw.toString('utf8')); } catch {}
        if (!validSub(sub)) return json(res, 400, { error: 'sub' });
        const ok = await db.subscribe(c, id, name, { endpoint: sub.endpoint, keys: sub.keys }, now);
        return json(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'full' });
      }
      case 'unsub':
        await db.unsubscribe(c, id);
        return json(res, 200, { ok: true });
      case 'clip': {
        const t = q.get('t') === 'p' ? 'p' : 'v';
        const bytes = await readBody(req, t === 'p' ? MAX_PHOTO_BYTES : MAX_VOICE_BYTES);
        if (!bytes || bytes.length < 100 || (t === 'p' && !isJpeg(bytes))) return json(res, 413, { error: 'size' });
        const meta = {
          k: crypto.randomUUID(),
          from: id,
          name,
          t,
          ms: t === 'v' ? Math.min(MAX_TALK_MS, Math.max(0, Number(q.get('ms')) || 0)) : 0,
          ts: Date.now(), // after the upload, so it orders with polls made meanwhile
        };
        const targets = await db.addClip(c, id, meta, bytes, meta.ts);
        json(res, 200, { ok: true, k: meta.k, ts: meta.ts });
        // Alerts go out after the response so the sender isn't kept waiting.
        waitUntil(notify(db, c, targets, meta, req.headers.host).catch((err) => console.warn('notify', err)));
        return;
      }
    }
    return json(res, 404, { error: 'action' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'server' });
  }
}

module.exports = { handle, MAX_TALK_MS };
