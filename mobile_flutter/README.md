# Grasberg Mobile (Flutter)

Native phone client for [Grasberg](../README.md) — one codebase for **Android
and iOS**. It connects to your desktop through the same relay, speaks the same
end-to-end encrypted protocol as the desktop-hosted phone web client
(`src/mobile/`), and shares the same conversation state: you chat on the
desktop, pick up the phone, and the conversation — including live streaming —
is right there, on every device at once.

```
Phone (this app)          Relay (dumb router)           Desktop (Electron)
     │  outbound wss  ──▶  routes opaque frames  ◀──  outbound wss  │
     └──────────── AES-256-GCM sealed frames ─────────────────────┘
```

The desktop opens **no inbound port**; both ends dial out to the relay and
every application frame is end-to-end encrypted (HKDF-SHA256 frame key from
the QR pairing secret, AES-256-GCM per frame). The relay sees ciphertext and
routing metadata only. Protocol: `src/shared/remote-protocol.ts`.

## What works

- **Pairing**: scan the desktop's QR (Settings → Bridges → Remote access), or
  enter relay URL / desktop ID / secret manually. The secret is consumed once,
  proved with an HMAC, never stored.
- **Conversations**: list, open, create, delete, live snippets.
- **Chat**: send, streaming answers (text + collapsible reasoning), stop,
  regenerate — the desktop's own pipeline runs the model; the phone is a live
  window into it.
- **Interactive cards**: tool approvals (allow once / deny) and model
  questions (chips + custom answer) follow you between views.
- **Multi-device simultaneity**: every surface re-fetches on
  `push:conversationsChanged` and on reconnect, so desktop edits, other
  phones' messages and workflow results all appear without manual refresh.
- **Connection discipline**: auto-reconnect with backoff, presence
  (desktop online/offline), replay-protected request sequences persisted
  before send, identity revocation handled (4401 → re-pair).

Deliberately out (mirrors the desktop's remote allowlist): settings, provider
keys, filesystem/git, terminal. The phone is trusted, but its surface stays
minimal on principle — see `src/main/remote/router.ts`.

## Layout

```
lib/
  main.dart               app entry, theme (palette from src/mobile/mobile.css), routing, toast
  protocol/
    constants.dart        protocol version + HKDF/HMAC context strings (must match desktop)
    crypto.dart           pairing proof, HKDF frame key, seal/open AES-256-GCM frames
    urls.dart             relay URL normalization + QR payload parsing
  state/
    identity.dart         paired identity + secure storage (Keychain/Keystore)
    tunnel.dart           the WebSocket tunnel: hello, req/res (seq+timeout), push, reconnect
    pairing.dart          one-shot pairing exchange over a `pairing`-role connection
    channels.dart         IPC/push channel names (subset of src/shared/ipc.ts)
    app_store.dart        single ChangeNotifier store — the port of src/mobile/store.ts
  models/models.dart      typed views of the desktop's JSON (lenient by design)
  screens/                pair / scan / home / chat / settings
  widgets/                message bubble (markdown + reasoning), approval cards
tool/
  gen-interop-vectors.mjs generates WebCrypto test vectors (Node)
  dart_seal_verify.dart   seals frames with Dart for the reverse check
test/
  interop_test.dart       crypto/URL/QR interop vs. committed fixtures
  app_store_test.dart     push-channel reduction rules
```

## Wire-format interop is proven, not assumed

The fixtures in `test/fixtures/interop.json` are generated with the exact
WebCrypto calls the desktop-hosted phone client uses:

- Node (WebCrypto) seals frames + derives the key → the Dart tests open them
  and verify the HKDF/HMAC values byte-for-byte.
- Dart seals frames (`dart run tool/dart_seal_verify.dart`) → Node opens them:
  `node tool/gen-interop-vectors.mjs --verify test/fixtures/dart-sealed.json`

Both directions pass, so the Flutter client interoperates with the desktop's
`src/main/remote/` implementation by construction. Note the `ct` layout:
`ciphertext || tag` (tag last, 16 bytes) — WebCrypto's convention, part of the
wire contract.

## Build & run

Requires the [Flutter SDK](https://docs.flutter.dev/get-started/install);
build each platform on its own OS (Android anywhere, iOS on macOS).

```bash
cd mobile_flutter
flutter pub get
flutter test              # unit + interop tests (no device needed)
flutter analyze
flutter run               # on a connected device/emulator
flutter build apk         # release APK → build/app/outputs/flutter-apk/
flutter build ipa         # iOS (macOS + Xcode)
```

Android requirements already wired: `INTERNET` (outbound tunnel only) and
`CAMERA` (QR scan) permissions; iOS: `NSCameraUsageDescription`.

## Pairing walkthrough

1. Desktop: **Settings → Bridges → Remote access** — enable, configure relay +
   client URL, open the pairing QR.
2. Phone: **Scan QR code** → point at the screen.
3. The app connects as `pairing`, proves the secret (HMAC, never the secret),
   receives its device ID + relay token sealed under the derived frame key,
   stores the identity in the secure storage and connects.
4. Same conversations, same streaming, same approvals — as if you were at the
   desktop.

The desktop-hosted web client (`src/mobile/`) and this native app are peers:
either can be paired, both stay connected at the relay, and pushes fan out to
all of them (`devices-online` reconstruction covers tunnel flaps).

## Security notes

- The pairing secret lives in the QR only; the app stores the *derived frame
  key* + relay token in `flutter_secure_storage` (iOS Keychain / Android
  Keystore).
- Request sequences are strictly monotonic and persisted **before** each
  network send; the desktop rejects replays (see
  `remote_devices.claimRequestSequence`).
- Relay close code `4401` (revoked/lost registration) wipes the identity and
  drops the user at the pairing gate — retrying a dead identity is pointless.
- Plain `ws://`/`http://` relays are accepted only for loopback (development).
