# Mobilstyrning av Grasberg — full mobilklient via inbyggd E2E-krypterad relay + förbättrad Telegram-bridge

## Arkitekturöversikt

Tre nya komponenter + en tunnel, allt versionssynkat från desktop:

```
[Mobil: PWA-ish webbklient]  ←WSS→  [Relay (hostad, dumb pipe)]  ←WSS←  [Desktop: RemoteService]
                                                                        (ansluter UTÅT — noll inkommande portar)
```

**Nyckelbeslut:**
1. **Relay är den enda transporten** (ingen separat LAN-lyssnare). Desktop ansluter utåt till relän — appens invariant "noll inkommande nätverksyta" (trigger-server.ts:6-18) bevaras, och det fungerar bakom CGNAT/brandvägg. Lokal testning: relay på 127.0.0.1.
2. **Mobil-UI:et serveras från desktop genom tunneln** (relay är dumb pipe) — alltid versionsmatchat med main-koden, ingen separat hosting av UI.
3. **Samma protokoll som IPC**: fjärrrouter återanvänder handler-mapen från `registerIpc` med en explicit allowlist; push-event (inkl. `streamEvent`) vidarebefordras via samma `broadcast`-buss.
4. **End-to-end-kryptering**: alla frames efter parning är AES-256-GCM med nyckel `HKDF(paringCode)` — relän ser bara ciphertext. Paring via QR-kod med 256-bit hemlighet (HMAC-bevis, relän ser aldrig koden). Mönstren lånas från Telegram-pairingen (TTL, max försök, rotation) och trigger-servern (timing-safe jämförelse, minta main-side).
5. **`ws` blir ny dependency** (ren JS, inga native builds) för desktop-klient + relay-server.

## Fas 1a — Grund i main-processen

**Event-buss** — `src/main/events.ts`: `publish(channel, payload)` + `subscribe()`. `broadcast()` i index.ts:95-101 prenumererar och skickar vidare till fönster; RemoteService prenumererar för push-vidarebefordran.

**Handler-map** — `registerIpc` (`src/main/ipc/register.ts:570`) bygger idag via lokal `register()`. Refaktorera: samla handlers i en `Map<ChannelName, fn>` som returneras från `registerIpc`; ipcMain-wiring blir en loop över mappen. RemoteServicen anropar samma handlers med allowlist.

**Nya filer `src/main/remote/`:**
- `service.ts` — livscykel (start/stop/sync på settings-ändring, som trigger-serverns `sync()`), upprätthåller relay-anslutning med backoff (3s→60s)
- `pairing.ts` — QR-parning: 256-bit kod, TTL 15 min, max 5 fel innan rotation, timing-safe HMAC-verifiering
- `crypto.ts` — HKDF + AES-256-GCM frame-(kryp|dekryp)t; nycklar per enhet i `tool_secrets` via Keystore (scope `remote`)
- `router.ts` — allowlist (~25 kanaler): convList/Create/Get/Update/Delete/Messages, chatSend/Stop/Regenerate/EditAndRerun/Compact, toolsApprovalRespond, questionRespond, workflowsList/RunById/Runs/Overview, imStatus, appGetInfo, remoteStatus. **Exkluderat:** settingsGet (innehåller paringskoder/tokens), alla settings-skrivningar, providers/nycklar, terminal, kod/git, backup, dataDeleteAllContent
- `relay-client.ts` — utgående WSS-klient + HTTP-over-tunnel för statiskt mobil-UI
- `static.ts` — serverar `out/mobile/` genom tunneln (ETag-cache)

**DB-migration v37** (`src/main/db/migrations.ts`, append-only): tabell `remote_devices` (id, name, created_at, last_seen_at, token_hash, key_fingerprint, revoked_at).

**Kontrakt** — `src/shared/types.ts`: `AppSettings.remoteAccessEnabled`, `remoteRelayUrl` (+ i `SECURITY_SENSITIVE_SETTING_KEYS`), `RemoteStatus`, `RemoteDevice`. `src/shared/ipc.ts` + preload: `remoteStatus/Pair/DevicesList/DeviceRevoke/SetConfig` → `window.uld.remote`.

**Desktop-UI** — ny sektion i `src/renderer/src/components/settings/BridgesTab.tsx`: på/av, relay-URL, QR-parningsmodal, enhetslista med revoke.

**SMOKE_TEST** hoppar relay-start (som schedulers, index.ts:820-826).

## Fas 1b — Relay-servern (`relay/`, eget npm-paket)

- `relay/src/index.ts`: Node + `ws`; desktop-anslutningar (autentiserade med `relaySecret` mintad vid första anslutning, hash lagrad), mobil-anslutningar (device-token, hash lagrad), routing efter desktopId; HTTP-proxy `GET /:desktopId/*` → tunnel → desktops statiska svar; in-memory routing, minimal SQLite/JSON för token-hashar; inga meddelanden lagras
- Dockerfile + deploy-doc (Fly.io/Railway/VPS), `relay/README.md`
- Inkludera relay-tester i rot-vitest (ren Node, kräver bara `ws`)

## Fas 1c — Mobilklienten (`src/mobile/`, andra vite-roten)

React 19 + Zustand, återanvänder `@shared`-typer och zod-scheman; egen slank bundle (inte fulla desktop-appen):
- **Parning**: läser QR-fragment, HMAC-bevis, lagrar deviceKey/token i IndexedDB
- **Konversationslista** (sök, lägesikoner) → **chattvy**: historik (pagginerad), skicka, live-streaming via push-events, stop/regenerate/edit+rerun
- **Verktygsgodkännanden + modellfrågor** som interaktiva kort (samma "först svar vinner"-semantik som desktop/Telegram)
- Bygg: `vite.mobile.config.ts` → `out/mobile/`; npm-scripts `build:mobile`/`dev:mobile`; electron-builder `files` += `out/mobile/**`
- Tillståndssynk vid återanslutning via convGet (inget replay-buffer; approvals har redan 3-min-timeout)

## Fas 2 — Notiser + bredare yta
Web Push (VAPID, nyckelpar per installation i Keystore; service worker i mobil-bundlen) för godkännanden och färdiga svar när ingen WS är ansluten; workflows-lista/kör + inkorg i mobil-UI; bilagor (kamera/galleri) om tid.

## Fas 3 — Telegram-bridge-förbättringar
`/conversations`, `/switch N`, `/new`-kommandon (fler konversationer än den bundna), meddelande-delning >4000 tecken istället för trunkering, `parse_mode` Markdown i svar. Små, avgränsade ändringar i `src/main/im/manager.ts` + `telegram.ts`.

## Säkerhet (sammanfattning)
E2E AES-GCM efter parning; relän autentiserar med hashade tokens men läser aldrig payloads; allowlist blocking innan validering; `redactSecrets` på allt felinnehåll som lämnar maskinen; säkerhetsklassificerade settings importeras aldrig från backup; revoke per enhet = token spärrad + nyckel raderad.

## Testplan
- Unit: pairing (TTL/fel/rotation), crypto round-trip, router-allowlist (förbjuden kanal → err), static-server, relay routing/auth (lokala WS-portar), mobilstores
- Befintliga gates efter varje fas: `tsc` ×2, `vitest run`, `electron-vite build`, `SMOKE_TEST=1 npx electron .` — plus `npm run bundle:check`

## Ordning & leverans
1a → 1b → 1c (tillsammans = körbar beta: parna telefonen via QR och chatta med full streaming) → 2 → 3. Varje fas är oberoende shippbar och lämnar testerna gröna.