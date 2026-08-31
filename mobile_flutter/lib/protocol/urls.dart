/// Relay URL normalization and QR pairing-payload parsing — the Dart mirror of
/// the URL helpers in src/mobile/tunnel.ts. The rules are a security boundary:
/// plain ws:// is allowed only for loopback relays, everything else must be
/// wss://.
/// The pairing QR is the desktop's client URL with a fragment:
/// `#p=<43-char secret>&relay=<relay url>&desktop=<desktop id>`.
class PairingQr {
  const PairingQr({required this.secret, required this.relayUrl, required this.desktopId});

  /// The one-time 256-bit pairing secret (base64url, 43 chars).
  final String secret;
  final String relayUrl;
  final String desktopId;
}

/// Normalizes a user/QR-supplied relay URL to `ws(s)://host/ws`, or null when
/// the input is not an acceptable relay endpoint.
String? relayWsUrl(String input) {
  final uri = Uri.tryParse(input.trim());
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) return null;
  final secure = uri.scheme == 'https' || uri.scheme == 'wss';
  final host = uri.host.toLowerCase();
  final loopback = host == 'localhost' ||
      host == '127.0.0.1' ||
      host == '[::1]' ||
      host == '::1';
  if (!secure && !(loopback && (uri.scheme == 'http' || uri.scheme == 'ws'))) return null;
  final scheme = secure ? 'wss' : 'ws';
  final port = uri.hasPort ? ':${uri.port}' : '';
  return '$scheme://$host$port/ws';
}

/// Parses a scanned QR payload (or a pasted pairing link). Returns null for
/// anything malformed — the fields are validated with the same regexes the
/// desktop's web client uses.
PairingQr? parsePairingQr(String text) {
  final uri = Uri.tryParse(text.trim());
  if (uri == null) return null;
  final params = Uri.splitQueryString(uri.fragment);
  final secret = params['p'];
  final relay = params['relay'];
  final desktop = params['desktop'];
  if (secret == null || relay == null || desktop == null) return null;
  if (!RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(secret)) return null;
  if (!RegExp(r'^[A-Za-z0-9-]{1,64}$').hasMatch(desktop)) return null;
  if (relayWsUrl(relay) == null) return null;
  return PairingQr(secret: secret, relayUrl: relay, desktopId: desktop);
}
