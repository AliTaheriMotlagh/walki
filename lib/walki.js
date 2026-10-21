'use strict';

// Channel logic over plain HTTP, shared by the Vercel function (api/[action].js)
// and the local dev server (server.js). Clients poll for channel state; a
// transmission is recorded on the talker's device and uploaded as one clip when
// they let go, so it works anywhere plain HTTPS to the app does.
//
// State lives in Upstash Redis (Vercel Marketplace -> Upstash for Redis sets
// KV_REST_API_URL / KV_REST_API_TOKEN). Without it an in-memory store is used,
// which only works inside a single process (local dev).

const crypto = require('crypto');

const MAX_MEMBERS = Number(process.env.MAX_MEMBERS) || 16;
const MAX_TALK_MS = Number(process.env.MAX_TALK_MS) || 60_000;
const FLOOR_MS = MAX_TALK_MS + 15_000; // also covers the upload after release
const STALE_MS = 12_000; // a member who hasn't polled for this long has left
const CLIP_TTL_S = 600;
const KEEP_CLIPS = 20;
const CHANNEL_TTL_S = 3600;
const CLIP_RATE = 8000; // 8 kHz mu-law: 1 byte per sample
const MAX_CLIP_BYTES = CLIP_RATE * (MAX_TALK_MS / 1000 + 5);

const ID_RE = /^[a-z0-9-]{8,40}$/i;
const clean = (s, max) => String(s || '').trim().slice(0, max);
const channelKey = (s) => clean(s, 24).toLowerCase().replace(/[^a-z0-9-]/g, '');

// ---------------------------------------------------------------------------
// Stores. Both expose the same async API:
//   poll(c, id, name, now) -> { members: [{id, name}], talker, clips } | 'full'
//   talk(c, id, now)       -> '' when granted, else the current talker's id
//   release(c, id, leaving)
//   addClip(c, id, meta, bytes)
//   getClip(c, k)          -> Buffer | null
// ---------------------------------------------------------------------------

// Each operation is one Lua script, so it is atomic and a single Redis command.
const POLL_LUA = `
local m, f, c = KEYS[1], KEYS[2], KEYS[3]
local id, name, now, stale, max, ttl = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), ARGV[6]
local all = redis.call('HGETALL', m)
local live, known = {}, false
for i = 1, #all, 2 do
  local v = all[i + 1]
  local sep = string.find(v, '|', 1, true)
  if now - tonumber(string.sub(v, 1, sep - 1)) > stale then
    redis.call('HDEL', m, all[i])
  elseif all[i] == id then
    known = true
  else
    live[#live + 1] = all[i]
    live[#live + 1] = string.sub(v, sep + 1)
  end
end
if not known and #live / 2 + 1 > max then return 'full' end
redis.call('HSET', m, id, now .. '|' .. name)
redis.call('EXPIRE', m, ttl)
return {live, redis.call('GET', f) or '', redis.call('LRANGE', c, 0, -1)}`;

const TALK_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= ARGV[1] then return cur end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return ''`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
if ARGV[2] == '1' then redis.call('HDEL', KEYS[2], ARGV[1]) end
return 1`;

const CLIP_LUA = `
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[4])
redis.call('RPUSH', KEYS[2], ARGV[3])
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[5]), -1)
redis.call('EXPIRE', KEYS[2], ARGV[4])
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1`;

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
  const k = (c) => ({ members: `w:${c}:m`, floor: `w:${c}:f`, clips: `w:${c}:c`, audio: (id) => `w:${c}:a:${id}` });

  return {
    async poll(c, id, name, now) {
      const keys = k(c);
      const r = await run(POLL_LUA, [keys.members, keys.floor, keys.clips], [id, name, now, STALE_MS, MAX_MEMBERS, CHANNEL_TTL_S]);
      if (r === 'full') return r;
      const [flat, floor, clips] = r;
      const members = [];
      for (let i = 0; i < flat.length; i += 2) members.push({ id: flat[i], name: flat[i + 1] });
      return { members, talker: floor || null, clips: clips.map((s) => JSON.parse(s)) };
    },
    async talk(c, id) {
      return run(TALK_LUA, [k(c).floor], [id, FLOOR_MS]);
    },
    async release(c, id, leaving) {
      const keys = k(c);
      await run(RELEASE_LUA, [keys.floor, keys.members], [id, leaving ? 1 : 0]);
    },
    async addClip(c, id, meta, bytes) {
      const keys = k(c);
      await run(CLIP_LUA, [keys.floor, keys.clips, keys.audio(meta.k)], [id, bytes.toString('base64'), JSON.stringify(meta), CLIP_TTL_S, KEEP_CLIPS]);
    },
    async getClip(c, clipId) {
      const b64 = await call(['GET', k(c).audio(clipId)]);
      return b64 ? Buffer.from(b64, 'base64') : null;
    },
  };
}

function memoryStore() {
  const channels = new Map();
  const get = (c) => {
    let ch = channels.get(c);
    if (!ch) channels.set(c, (ch = { members: new Map(), floor: null, clips: [], audio: new Map() }));
    return ch;
  };
  const floorOf = (ch, now) => (ch.floor && ch.floor.until > now ? ch.floor.id : '');

  return {
    async poll(c, id, name, now) {
      const ch = get(c);
      const members = [];
      for (const [mid, m] of ch.members) {
        if (now - m.seen > STALE_MS) ch.members.delete(mid);
        else if (mid !== id) members.push({ id: mid, name: m.name });
      }
      if (!ch.members.has(id) && members.length + 1 > MAX_MEMBERS) return 'full';
      ch.members.set(id, { name, seen: now });
      return { members, talker: floorOf(ch, now) || null, clips: ch.clips };
    },
    async talk(c, id, now) {
      const ch = get(c);
      const cur = floorOf(ch, now);
      if (cur && cur !== id) return cur;
      ch.floor = { id, until: now + FLOOR_MS };
      return '';
    },
    async release(c, id, leaving) {
      const ch = get(c);
      if (ch.floor && ch.floor.id === id) ch.floor = null;
      if (leaving) ch.members.delete(id);
    },
    async addClip(c, id, meta, bytes) {
      const ch = get(c);
      ch.audio.set(meta.k, bytes);
      ch.clips.push(meta);
      while (ch.clips.length > KEEP_CLIPS) ch.audio.delete(ch.clips.shift().k);
      if (ch.floor && ch.floor.id === id) ch.floor = null;
    },
    async getClip(c, clipId) {
      const ch = channels.get(c);
      return (ch && ch.audio.get(clipId)) || null;
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

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

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

// GET  /api/poll?c&id&name      -> { members, talker, clips }
// POST /api/talk?c&id           -> { ok } | { busy: talkerId }
// POST /api/release?c&id        -> { ok }
// POST /api/leave?c&id          -> { ok }   (sendBeacon friendly)
// POST /api/clip?c&id&name&ms   body: 8 kHz mu-law bytes -> { ok, k }
// GET  /api/clip?c&k            -> the clip's bytes
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = (req.query && req.query.action) || url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const q = url.searchParams;

  const db = getStore();
  if (!db) return json(res, 503, { error: 'storage' });
  const c = channelKey(q.get('c'));
  if (!c) return json(res, 400, { error: 'channel' });

  try {
    if (action === 'clip' && req.method === 'GET') {
      const k = q.get('k') || '';
      if (!ID_RE.test(k)) return json(res, 400, { error: 'clip' });
      const audio = await db.getClip(c, k);
      if (!audio) return json(res, 404, { error: 'gone' });
      // Clips never change, so the CDN can serve every listener after the first.
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': `public, max-age=${CLIP_TTL_S}, s-maxage=${CLIP_TTL_S}, immutable`,
      });
      return res.end(audio);
    }

    const id = q.get('id') || '';
    if (!ID_RE.test(id)) return json(res, 400, { error: 'id' });
    const name = clean(q.get('name'), 20) || 'Guest';
    const now = Date.now();

    if (action === 'poll') {
      const r = await db.poll(c, id, name, now);
      return r === 'full' ? json(res, 409, { error: 'full' }) : json(res, 200, r);
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });

    switch (action) {
      case 'talk': {
        const holder = await db.talk(c, id, now);
        return json(res, 200, holder ? { busy: holder } : { ok: true });
      }
      case 'release':
      case 'leave':
        await db.release(c, id, action === 'leave');
        return json(res, 200, { ok: true });
      case 'clip': {
        const bytes = await readBody(req, MAX_CLIP_BYTES);
        if (!bytes || bytes.length < 100) return json(res, 413, { error: 'size' });
        const meta = {
          k: crypto.randomUUID(),
          from: id,
          name,
          ms: Math.min(MAX_TALK_MS, Math.max(0, Number(q.get('ms')) || 0)),
          ts: now,
        };
        await db.addClip(c, id, meta, bytes);
        return json(res, 200, { ok: true, k: meta.k });
      }
    }
    return json(res, 404, { error: 'action' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'server' });
  }
}

module.exports = { handle, MAX_TALK_MS };
