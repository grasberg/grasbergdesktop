import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Rich composer state (including attachment references) stays encrypted locally.
class RichDrafts {
  final _storage = const FlutterSecureStorage();
  // Shared across WebView instances and AppStore.forgetDevice. Clearing must
  // run after every already queued write, including writes from a disposed UI.
  static final _queues = <String, Future<void>>{};
  Future<T> _enqueue<T>(String device, Future<T> Function() action) {
    final operation = (_queues[device] ?? Future<void>.value()).then(
      (_) => action(),
    );
    final settled = operation.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    _queues[device] = settled;
    settled.then((_) {
      if (identical(_queues[device], settled)) _queues.remove(device);
    });
    return operation;
  }

  String _prefix(String device) => 'grasberg.rich-drafts.$device.';
  String _key(String device, String conversation) {
    if (conversation.isEmpty ||
        conversation.length > 100 ||
        !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(conversation)) {
      throw const FormatException('Invalid conversation.');
    }
    return '${_prefix(device)}$conversation';
  }

  Future<Object?> get(String device, String conversation) =>
      _enqueue(device, () async {
        final raw = await _storage.read(key: _key(device, conversation));
        return raw == null ? null : jsonDecode(raw);
      });

  Future<void> save(String device, String conversation, Object? draft) {
    final raw = jsonEncode(draft);
    if (raw.length > 8 * 1024 * 1024) {
      throw const FormatException('This draft is too large to save.');
    }
    final key = _key(device, conversation);
    return _enqueue(device, () => _storage.write(key: key, value: raw));
  }

  Future<void> clear(String device) => _enqueue(device, () async {
    final prefix = _prefix(device);
    final values = await _storage.readAll();
    for (final key in values.keys.where((key) => key.startsWith(prefix)).toList()) {
      await _storage.delete(key: key);
    }
  });
}
