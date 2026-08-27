# Grasberg relay

The hosted half of Grasberg's remote access ("use the app from your phone").
It is a **dumb, content-blind router**: the desktop app connects out to it,
phones connect to it, and everything desktop↔phone is end-to-end encrypted
(AES-256-GCM, keys derived from a QR pairing code the relay never sees). The
relay stores only SHA-256 hashes of connection tokens — no messages, no
history, no content, ever.

## What it does

- One WebSocket endpoint, `/ws`, speaking the frames in
  `src/shared/remote-protocol.ts` (desktop tunnels, paired devices,
  pairing-role connections).
- One HTTP route, `GET /<desktopId>/*`, that tunnels asset requests to the
  desktop so the phone loads the mobile UI straight from the desktop app —
  always version-matched. `GET /healthz` for monitoring.

## Run it

```bash
# From the repository root — build a single-file bundle (no deps at runtime):
npm run build:relay
PORT=8790 node relay/relay.mjs

# Or with Docker:
docker build -t grasberg-relay -f relay/Dockerfile .
docker run -d -p 8790:8790 -v relay-data:/data grasberg-relay
```

Then point Grasberg at it: Settings → Bridges → Remote access →
`https://your-relay.example.com` (put TLS in front — the relay speaks plain
HTTP/WS; a platform terminator like Fly.io, Railway or nginx does TLS).

## Deploying

- **Fly.io**: `fly launch --dockerfile relay/Dockerfile`, set `PORT=8790`,
  attach a small volume mounted at `/data` so token hashes survive restarts.
- **Any VPS**: run the Docker image behind nginx/Caddy for TLS, persist
  `/data`.
- For a home lab: run it on a loopback-facing machine and expose it through
  whatever tunnel you already use.

## Operational notes

- **TLS is required in production.** The desktop refuses non-https relay URLs
  outside localhost, precisely so a plaintext hop cannot be configured by
  accident.
- **Residual trust, stated plainly:** each phone keeps its device token and
  frame key in `localStorage` under the relay's origin. The relay never sees
  the key (all content is end-to-end encrypted), but code running on the relay
  origin — i.e. the mobile app itself, plus anything that manages to inject
  script into it — could read that identity and impersonate the phone. The
  mobile app renders markdown without raw HTML for exactly this reason, and
  revoking a device on the desktop invalidates a stolen token immediately.
- **The store** (`/data/relay-store.json`) holds desktop/device token hashes.
  Wiping it logs everyone out: desktops re-register on next connect
  (trust-on-first-use), phones must be re-paired.
- **A lost desktop token** (wiped desktop app): wipe the store, or just delete
  the stale `desktops` entry — the id will re-register.
- **Nothing to comply with**: there is no user content here to serve or
  delete; requests from unknown desktops get a 503 and nothing else.

## Tests

`tests/unit/relay/server.test.ts` (in the root repo) runs the relay on
loopback with real WebSocket connections.
