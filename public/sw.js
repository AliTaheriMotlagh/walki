// walki service worker
// - App shell: network first with a short timeout, cache fallback. Launches
//   instantly on bad networks and is always fresh on good ones.
// - Background alerts: Web Push shows a notification for every message sent
//   while the app is closed, and prefetches it so it plays instantly.
const VERSION = 'v4';
const SHELL_CACHE = `walki-shell-${VERSION}`;
const MEDIA_CACHE = 'walki-media'; // shared with the page, which prunes it
const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/recorder.js',
  '/camera.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/badge.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      // One missing file must not block the update.
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith('walki-shell-') && k !== SHELL_CACHE) || k === 'walki-v3').map((k) => caches.delete(k))))
      .then(() => self.registration.navigationPreload && self.registration.navigationPreload.enable().catch(() => {}))
      .then(() => self.clients.claim())
  );
});

const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms, null));

async function shell(e) {
  const { request } = e;
  const isPage = request.mode === 'navigate';
  const key = isPage ? '/' : request;
  const network = (async () => {
    const res = (isPage && (await e.preloadResponse)) || (await fetch(request));
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(key, copy)));
    }
    return res;
  })();
  network.catch(() => {});
  const cached = await caches.match(key, { ignoreSearch: isPage });
  if (!cached) return network.catch(() => Response.error());
  // Prefer fresh, but never wait more than 2.5 s for it.
  const fresh = await Promise.race([network.catch(() => null), timeout(2500)]);
  return fresh || cached;
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  // API calls are live channel state (the page caches clips itself).
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(shell(e));
});

// ---------------------------------------------------------------------------
// Background alerts
// ---------------------------------------------------------------------------
const fmt = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const clipUrl = (d) => `/api/clip?${new URLSearchParams({ c: d.c, k: d.k })}`;

async function prefetch(d) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const url = clipUrl(d);
    if (await cache.match(url)) return;
    const res = await fetch(url);
    if (res.ok) await cache.put(url, res);
  } catch {}
}

async function visibleClient(c) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return list.find((w) => w.visibilityState === 'visible' && w.focused && new URL(w.url).searchParams.get('c') === c);
}

async function onPush(d) {
  if (!d || !d.c || !d.k) return;
  const fetched = prefetch(d);
  // The server only alerts devices that aren't on screen. If the app has just
  // come back, nudge it to fetch now. A notification is still shown: Safari
  // revokes push permission from sites whose pushes show nothing.
  const open = await visibleClient(d.c);
  if (open) open.postMessage({ type: 'poll' });
  const tag = `walki-${d.c}`;
  const existing = await self.registration.getNotifications({ tag });
  const prev = existing[0] && existing[0].data;
  const count = (prev && prev.count) || 0;
  const n = count + 1;
  const what = d.t === 'p' ? '📷 Sent a photo' : `🎙️ Voice message · ${fmt(d.ms || 0)}`;
  const opts = {
    tag,
    renotify: true,
    body: n > 1 ? `${d.n}: ${what}\n${n} new messages` : `${d.n}: ${what}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge.png',
    timestamp: d.ts || Date.now(),
    vibrate: [70, 50, 70],
    data: { ...d, count: n },
    actions: d.t === 'p' ? [{ action: 'open', title: 'View' }] : [{ action: 'open', title: 'Listen' }],
  };
  if (d.t === 'p') opts.image = clipUrl(d);
  await self.registration.showNotification(`#${d.c}`, opts);
  try {
    const all = await self.registration.getNotifications();
    const total = all.reduce((sum, x) => sum + ((x.data && x.data.count) || 0), 0);
    if (self.navigator.setAppBadge) await self.navigator.setAppBadge(total);
  } catch {}
  return fetched;
}

self.addEventListener('push', (e) => {
  let d = null;
  try { d = e.data && e.data.json(); } catch {}
  e.waitUntil(onPush(d));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const target = `/?${new URLSearchParams({ c: d.c || '', k: d.k || '' })}`;
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = list.find((w) => new URL(w.url).origin === location.origin);
      if (win) {
        win.postMessage({ type: 'open', c: d.c, k: d.k });
        return win.focus().catch(() => self.clients.openWindow(target));
      }
      return self.clients.openWindow(target);
    })()
  );
});

// The browser rotated the subscription: tell the page to register it again.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => list.forEach((w) => w.postMessage({ type: 'resubscribe' })))
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'clear') {
    e.waitUntil(
      self.registration.getNotifications({ tag: e.data.c ? `walki-${e.data.c}` : undefined })
        .then((list) => list.forEach((n) => n.close()))
    );
  }
});
