# walki

Push-to-talk walkie-talkie for iPhone, iPad, Android and desktop. Join a channel, hold the button to talk, let go to listen. Send a dual-camera photo, and catch up on anything you missed.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

Phones need **HTTPS** to use the microphone and camera. Fastest way to test on real devices:

```bash
npm run tunnel       # prints a public https://….trycloudflare.com link
```

Open the link on each phone → enter a name and the same channel → hold to talk.
Tap **Invite** (members row) or **⋯ → Invite people** to share a link that opens straight into the channel.

**Install as an app:** iPhone/iPad → Safari → Share → *Add to Home Screen*. Android → Chrome → *Install app* (or **⋯ → Install walki**). Installing is required on iPhone for background alerts.

## Features

- **Always on.** walki reopens the channel you were in. There is no idle timeout.
- **Background alerts.** When walki is closed or the screen is off, every voice message or photo arrives as a notification (Web Push). Tap it to listen. Turn on under **⋯ → Background alerts**, or from the banner.
- **Missed messages.** The **History** button lists the last 24 hours of voice messages and photos, with missed ones highlighted and a **Play missed** button. A badge on the button and on the app icon counts unread messages. History is saved on the device for 7 days.
- **Dual photo.** One photo from the back camera with the front camera inset. Phones that can run both cameras at once capture them in the same instant; iPhone and others capture one, then the other a moment later.
- **Battery friendly.** On screen, walki polls every 1.5–5 s depending on activity. In the background it keeps listening for 2 minutes, then stops completely and lets push alerts wake the phone. The mic only opens while you talk (plus a few seconds for a quick reply), and the audio engine sleeps in the background. Keeping the screen on is optional (**⋯ → Keep screen on**).
- **Works with the silent switch** (iPhone 16.4+), and incoming messages play through the loudspeaker.

## How it works

Everything runs on Vercel over plain HTTPS, free plan friendly. There are no WebSockets and no peer-to-peer connections, so it works on networks that block WebRTC.

| Part | What |
|---|---|
| `lib/walki.js` | Channel logic: members (on screen / away), the *floor* (one talker per channel; others get a busy signal), clips and photos (kept 24 h, last 50), alert subscriptions, Web Push. State lives in Upstash Redis; each request is one atomic Lua script. |
| `api/[action].js` | The Vercel function serving `/api/*`. |
| `public/app.js` | The app: polling, push-to-talk, playback queue, history, alerts, settings. Voice is recorded with `public/recorder.js` (AudioWorklet) and sent as 8 kHz mu-law (~8 KB per second of speech). |
| `public/camera.js` | Dual camera, loaded only when opened. |
| `public/sw.js` | Service worker: offline app shell, push notifications, prefetches alerted messages so they play instantly. |
| `server.js` | Local dev server: same API plus the static files, using an in-memory store when no Redis is configured. |
| `public/styles.css` | Brand tokens, light/dark themes, all animation (GPU-only transforms/opacity). |

### Caching and cleanup

- **Server:** clips and photos expire after 24 h (max 50 per channel), member lists after 1 h idle, alert subscriptions after 14 days unused. Push endpoints that report gone (404/410) are deleted at once.
- **Device:** messages and their audio/photos (Cache Storage) are pruned to 7 days / 200 per channel on every launch; orphaned media is removed. **⋯ → Clear history** wipes a channel. The app shell is cached per version and old versions are deleted.

## Deploy on Vercel

1. In the Vercel dashboard open the **walki** project → **Storage** → **Create Database** → **Upstash for Redis** (free plan, region *Frankfurt* to match `regions` in `vercel.json`) → connect it to the project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. `vercel deploy --prod`

Push alerts need no setup: a VAPID key pair is generated on first use and stored in Redis. To run locally against the same database: `vercel env pull .env.local`, then load those vars before `npm start`.

### Env vars

| Env var | Default | |
|---|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | – | Upstash Redis REST (`UPSTASH_REDIS_REST_URL` / `_TOKEN` also work). Required on Vercel. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Optional fixed Web Push keys (`npx web-push generate-vapid-keys`). |
| `VAPID_SUBJECT` | `https://<host>` | Contact for push services (`mailto:` or `https:` URL). |
| `MAX_MEMBERS` | `16` | on screen at once, per channel |
| `MAX_TALK_MS` | `60000` | max single transmission |
| `PORT` | `3000` | local server only |

Local HTTPS without a tunnel: put `key.pem` + `cert.pem` in `certs/` and the server switches to HTTPS automatically.

## Platform limits

- **Background:** browsers don't run web apps in the background (iOS especially), so walki uses push alerts instead: you get a notification and tap to listen. Messages don't play by themselves while the phone is locked. That needs a native app (iOS PushToTalk framework / Android foreground service); the code is ready to wrap with Capacitor.
- **iPhone alerts** need iOS 16.4+ and walki added to the Home Screen.
- **Both cameras at the same instant** only works where the phone and browser allow it (many Androids). Elsewhere the two shots are taken about a second apart.
- Voice is sent when you let go (like a voice message), not streamed live. Expect about 1–2 s from release to playback.
