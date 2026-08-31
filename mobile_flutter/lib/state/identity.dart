/// The paired device identity: relay endpoint, routing ids, relay auth token
/// and the frame key — stored in the platform keystore/Keychain via
/// flutter_secure_storage, never in plain preferences.
/// library directive for the doc comment above.
library;

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../protocol/constants.dart';
import '../protocol/urls.dart';

class Identity {
  Identity({
    required this.relayUrl,
    required this.desktopId,
    required this.deviceId,
    required this.token,
    required this.keyBase64,
    int nextRequestSeq = 1,
  }) : nextRequestSeq = nextRequestSeq > 0 ? nextRequestSeq : 1;

  /// The relay base URL as supplied by the QR (https/wss form).
  final String relayUrl;
  final String desktopId;
  final String deviceId;
  final String token;

  /// Frame key, base64 — sealed/checked against the desktop on connect.
  final String keyBase64;

  /// Next authenticated request sequence; older identities start at 1.
  int nextRequestSeq;

  Map<String, dynamic> toJson() => {
        'relayUrl': relayUrl,
        'desktopId': desktopId,
        'deviceId': deviceId,
        'token': token,
        'keyBase64': keyBase64,
        'nextRequestSeq': nextRequestSeq,
      };

  static Identity? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final relayUrl = raw['relayUrl'];
    final desktopId = raw['desktopId'];
    final deviceId = raw['deviceId'];
    final token = raw['token'];
    final keyBase64 = raw['keyBase64'];
    if (relayUrl is! String ||
        desktopId is! String ||
        deviceId is! String ||
        token is! String ||
        keyBase64 is! String) {
      return null;
    }
    if (relayWsUrl(relayUrl) == null || desktopId.isEmpty || deviceId.isEmpty) return null;
    final seq = raw['nextRequestSeq'];
    return Identity(
      relayUrl: relayUrl,
      desktopId: desktopId,
      deviceId: deviceId,
      token: token,
      keyBase64: keyBase64,
      nextRequestSeq: seq is int ? seq : 1,
    );
  }
}

/// Persists the identity in the platform secure storage.
class IdentityStore {
  IdentityStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  Future<Identity?> load() async {
    final raw = await _storage.read(key: identityStoreKey);
    if (raw == null) return null;
    try {
      return Identity.fromJson(jsonDecode(raw));
    } catch (_) {
      return null;
    }
  }

  /// Persisted BEFORE each network send of a request: a crash may skip a
  /// number, but can never reuse one the desktop might already have executed.
  Future<void> save(Identity identity) =>
      _storage.write(key: identityStoreKey, value: jsonEncode(identity.toJson()));

  Future<void> clear() => _storage.delete(key: identityStoreKey);
}
