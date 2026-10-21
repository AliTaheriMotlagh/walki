# walki 

Push-to-talk walkie-talkie for iPhone, iPad, Android and desktop. Join a channel, hold the button to talk, let go to listen.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

Phones need **HTTPS** to use the microphone. Fastest way to test on real devices:

```bash
npm run tunnel       # prints a public https://….trycloudflare.com link
```

Open the link on each phone → enter a name and the same channel → hold to talk.
Tap **Share** (top right) to send an invite link that opens straight into the channel.

**Install as an app:** iPhone/iPad → Safari → Share → *Add to Home Screen*. Android → Chrome → *Install app*.

## How it works

Everything runs on Vercel over plain HTTPS. There are no WebSockets and no peer-to-peer connections, so it works on networks that block Render, STUN/TURN or WebRTC.

| Part | What |
|---|---|
| `lib/walki.js` | Channel logic: members, the *floor* (one talker per channel; others get a busy signal), voice clips. State lives in Upstash Redis; each request is a single atomic Lua script. |
| `api/[action].js` | The Vercel function serving `/api/poll`, `/api/talk`, `/api/release`, `/api/leave`, `/api/clip`. |
| `public/app.js` | Polls the channel every 1.5 s. Holding the button records from the mic (`public/recorder.js` worklet); letting go uploads the clip as 8 kHz mu-law (~8 KB per second of speech) and everyone else plays it. Expect about 1–2 s from release to playback. |
| `server.js` | Local dev server: same API plus the static files, using an in-memory store when no Redis is configured. |
| `public/styles.css` | Brand tokens, light/dark themes, all animation (GPU-only transforms/opacity). |

## Deploy on Vercel

1. In the Vercel dashboard open the **walki** project → **Storage** → **Create Database** → **Upstash for Redis** (free plan, region *Frankfurt* to match `regions` in `vercel.json`) → connect it to the project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. `vercel deploy --prod`

To run locally against the same database: `vercel env pull .env.local`, then load those vars before `npm start`.

### Env vars

| Env var | Default | |
|---|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | – | Upstash Redis REST (`UPSTASH_REDIS_REST_URL` / `_TOKEN` also work). Required on Vercel. |
| `MAX_MEMBERS` | `16` | per channel |
| `MAX_TALK_MS` | `60000` | max single transmission |
| `PORT` | `3000` | local server only |

Local HTTPS without a tunnel: put `key.pem` + `cert.pem` in `certs/` and the server switches to HTTPS automatically.

## Known platform limits

- **Background listening:** browsers pause audio when the app is in the background or the screen locks (iOS especially). walki keeps the screen awake while a channel is open. True locked-screen listening needs a native wrapper (iOS PushToTalk framework / Android foreground service), and this codebase is ready to wrap with Capacitor.
- Voice is sent after you let go (like a voice message), not streamed live.
- Each listener polls about 2,400 times an hour. The free Vercel and Upstash plans comfortably cover a small team; heavy use needs a paid plan.
