/// Phone-side cryptography — the Dart mirror of src/remote/crypto.ts (which is
/// itself the WebCrypto mirror of src/main/remote/crypto.ts).
///
/// Same constants, same wire format, so all three sides interoperate by
/// construction: the pairing secret from the QR derives the HKDF frame key;
/// every application frame is AES-256-GCM sealed. The sealed frame's `ct` is
/// WebCrypto's ciphertext||tag layout (tag last, 16 bytes) — that layout is
/// part of the wire contract and must not change.
library;

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'constants.dart';

final AesGcm _aesGcm = AesGcm.with256bits();

/// Cryptographically secure random bytes (frame nonces, request ids).
Uint8List randomBytes(int length) {
  final rng = Random.secure();
  return Uint8List.fromList(List<int>.generate(length, (_) => rng.nextInt(256)));
}

String bytesToHex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

/// HMAC-SHA256(secret, pairingProofContext) as hex — the pairing proof.
/// The secret itself never crosses the wire; this proof does.
Future<String> pairingProof(String secret) async {
  final mac = await Hmac.sha256().calculateMac(
    utf8.encode(pairingProofContext),
    secretKey: SecretKey(utf8.encode(secret)),
  );
  return bytesToHex(mac.bytes);
}

/// HKDF-SHA256(secret) → 256-bit AES-GCM frame key (raw bytes, storable
/// base64). Salt/info are the fixed public constants — all entropy is in the
/// 256-bit pairing secret.
Future<Uint8List> deriveFrameKey(String secret) async {
  final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
  final key = await hkdf.deriveKey(
    secretKey: SecretKey(utf8.encode(secret)),
    nonce: utf8.encode(frameKeySalt),
    info: utf8.encode(frameKeyInfo),
  );
  return Uint8List.fromList(await key.extractBytes());
}

/// Raw key bytes ⇄ base64 (identity storage).
String keyToBase64(List<int> key) => base64Encode(key);
Uint8List keyFromBase64(String text) => base64Decode(text);

/// Seals one JSON-serializable frame: AES-256-GCM with a fresh 12-byte nonce.
/// Returns the relay-visible `{t:'sec', n, ct}` map, `ct` = ciphertext||tag.
Future<Map<String, dynamic>> sealFrame(SecretKey key, Object? payload) async {
  final nonce = randomBytes(12);
  final box = await _aesGcm.encrypt(
    utf8.encode(jsonEncode(payload)),
    secretKey: key,
    nonce: nonce,
  );
  final sealed = BytesBuilder()..add(box.cipherText)..add(box.mac.bytes);
  return {'t': 'sec', 'n': base64Encode(nonce), 'ct': base64Encode(sealed.toBytes())};
}

/// Opens one sealed frame; throws on tampering or a wrong key.
Future<Object?> openFrame(SecretKey key, Map<String, dynamic> frame) async {
  final nonce = base64Decode(frame['n'] as String);
  final ct = base64Decode(frame['ct'] as String);
  if (ct.length < 16) {
    throw const FormatException('sealed frame too short');
  }
  final box = SecretBox(
    ct.sublist(0, ct.length - 16),
    nonce: nonce,
    mac: Mac(ct.sublist(ct.length - 16)),
  );
  final plain = await _aesGcm.decrypt(box, secretKey: key);
  return jsonDecode(utf8.decode(plain));
}

/// A random RFC 4122 v4 UUID, as the request id (matches the web client's
/// crypto.randomUUID — the desktop treats it as an opaque correlation id).
String randomUuid() {
  final b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final hex = bytesToHex(b);
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}
