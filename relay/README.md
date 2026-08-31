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
- One HTTP route, `GET /healthz`, for monitoring. Every asset path returns
  404: this process deliberately does not host or tunnel executable code.

The phone client is built separately with `npm run build:mobile`. Deploy the
contents of `out/mobile` to an HTTPS static origin you control, and configure
that URL as the **Mobile client URL** in Grasberg. It must not share the
relay's origin. The QR fragment tells that trusted client which relay and
desktop to connect to; the fragment is not sent in the HTTP request.

## Run it

```bash
# From the repository root — build a single-file bundle (no deps at runtime):
npm run build:relay
MOBILE_ORIGIN=https://phone.example.com PORT=8790 node relay/relay.mjs

# Or with Docker:
docker build -t grasberg-relay -f relay/Dockerfile .
docker run -d -p 8790:8790 -e MOBILE_ORIGIN=https://phone.example.com \
  -v relay-data:/data grasberg-relay
```

Then configure both URLs in Settings → Bridges → Remote access:

- Relay URL: `https://your-relay.example.com`
- Mobile client URL: `https://phone.example.com`

Put TLS in front of the relay — it speaks plain HTTP/WS; a platform terminator
like Fly.io, Railway or nginx can terminate TLS. `MOBILE_ORIGIN` is mandatory
for browser connections and must exactly match the mobile client's origin.

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
- **Origin separation is required.** Each phone keeps its device token and
  frame key under the trusted mobile origin. Browser WebSocket upgrades are
  rejected unless their `Origin` exactly matches `MOBILE_ORIGIN`; non-browser
  desktop connections do not send an Origin header.
- **Upgrading to the hardened protocol revokes old pairings.** Pair each phone
  again so it receives the anti-replay sequence state and trusted client URL.
- **The store** (`/data/relay-store.json`) holds desktop/device token hashes.
  Wiping it logs everyone out: desktops re-register on next connect
  (trust-on-first-use), phones must be re-paired.
- **A lost desktop token** (wiped desktop app): wipe the store, or just delete
  the stale `desktops` entry — the id will re-register.
- **Nothing to comply with**: there is no user content here to serve or
  delete; non-health HTTP paths return 404.

## Tests

`tests/unit/relay/server.test.ts` (in the root repo) runs the relay on
loopback with real WebSocket connections.
