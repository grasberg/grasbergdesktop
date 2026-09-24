import 'dart:convert';
import 'dart:math';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Drafts and unacknowledged sends stay in the phone's encrypted storage.
class DraftStore {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  Future<Map<String, dynamic>> load(String deviceId) async {
    final raw = await _storage.read(key: 'grasberg.drafts.$deviceId');
    if (raw == null) return {};
    return Map<String, dynamic>.from(jsonDecode(raw) as Map);
  }

  Future<void> save(String deviceId, Map<String, dynamic> data) =>
      _storage.write(key: 'grasberg.drafts.$deviceId', value: jsonEncode(data));
  Future<void> clear(String deviceId) =>
      _storage.delete(key: 'grasberg.drafts.$deviceId');
}

String newSendId() {
  final rng = Random.secure();
  final bytes = List.generate(16, (_) => rng.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((n) => n.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

class PendingSend {
  PendingSend(this.requestId, this.text, {this.sending = false, this.error});
  final String requestId;
  final String text;
  bool sending;
  String? error;
  Map<String, dynamic> toJson() => {'requestId': requestId, 'text': text};
}
