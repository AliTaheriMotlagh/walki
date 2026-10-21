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

| Part | What |
|---|---|
| `server.js` | Serves the app + WebSocket signalling. Owns the *floor*: only one person can talk per channel (others get a busy signal), auto-release after 60 s or if the talker drops. |
| `public/app.js` | WebRTC mesh between channel members. Opus voice (48 kHz mono, 32 kbps, in-band FEC for packet loss, echo cancellation + noise suppression). The mic track stays connected and is only *enabled* while you hold the button, so talk starts instantly. |
| `public/styles.css` | Brand tokens, light/dark themes, all animation (GPU-only transforms/opacity). |

## Production

Deploy anywhere that runs Node with HTTPS (Render, Railway, Fly.io, a VPS behind Caddy…).

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `TURN_URL` | – | e.g. `turns:turn.example.com:5349` (comma-separate several) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | |
| `MAX_MEMBERS` | `16` | per channel |
| `MAX_TALK_MS` | `60000` | max single transmission |

**Add a TURN server for production.** About 10–20% of mobile/corporate networks block direct connections; TURN relays audio for those users. Options: [coturn](https://github.com/coturn/coturn) on a VPS, or a hosted service (Cloudflare Calls TURN, Twilio, Metered).

Local HTTPS without a tunnel: put `key.pem` + `cert.pem` in `certs/` and the server switches to HTTPS automatically.

## Known platform limits

- **Background listening:** browsers pause audio when the app is in the background or the screen locks (iOS especially). walki keeps the screen awake while a channel is open. True locked-screen listening needs a native wrapper (iOS PushToTalk framework / Android foreground service), and this codebase is ready to wrap with Capacitor.
- Channels are designed for small teams (up to ~16). Bigger groups need an SFU media server (e.g. LiveKit) instead of the peer mesh.
