/// The one-shot pairing exchange over a `pairing`-role relay connection —
/// the Dart mirror of pairOverRelay in src/mobile/tunnel.ts.
///
/// The secret travels only inside the QR; this exchange sends an HMAC proof,
/// and the desktop's reply arrives sealed under the derived frame key, which
/// doubles as the key-agreement check.
/// library directive for the doc comment above.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:cryptography/cryptography.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/constants.dart';
import '../protocol/crypto.dart';
import '../protocol/urls.dart';

class PairingSuccess {
  PairingSuccess({
    required this.deviceId,
    required this.token,
    required this.desktopName,
    required this.keyBase64,
  });

  final String deviceId;
  final String token;

  /// Human-readable desktop label, for the device list.
  final String desktopName;
  final String keyBase64;
}

class PairingException implements Exception {
  const PairingException(this.message);
  final String message;

  @override
  String toString() => message;
}

String guessPlatform() {
  try {
    if (Platform.isIOS) return 'ios';
    if (Platform.isAndroid) return 'android';
  } catch (_) {
    // dart:io unavailable in some test hosts.
  }
  return 'mobile';
}

/// Runs the pairing exchange: connect as `pairing`, prove the secret, receive
/// the sealed identity. Throws [PairingException] with a human-readable reason
/// on every failure path.
Future<PairingSuccess> pairOverRelay(
  String desktopId,
  String secret,
  String relayUrl, {
  String? deviceName,
}) async {
  final url = relayWsUrl(relayUrl);
  if (url == null) {
    throw const PairingException('The pairing link has an invalid relay URL.');
  }
  final keyBytes = await deriveFrameKey(secret);
  final key = SecretKey(keyBytes);
  final proof = await pairingProof(secret);
  final name = deviceName ?? 'My phone';

  final completer = Completer<PairingSuccess>();
  WebSocketChannel? socket;

  void fail(String message) {
    if (completer.isCompleted) return;
    try {
      socket?.sink.close();
    } catch (_) {
      // Already gone.
    }
    completer.completeError(PairingException(message));
  }

  void succeed(PairingSuccess success) {
    if (completer.isCompleted) return;
    try {
      socket?.sink.close();
    } catch (_) {
      // Already gone.
    }
    completer.complete(success);
  }

  socket = WebSocketChannel.connect(Uri.parse(url));
  // The desktop's pairing offer expires; never hang on a silent relay.
  final timeout = Timer(const Duration(seconds: 60), () {
    fail('The desktop did not answer the pairing request in time.');
  });

  Future<void> onMessage(Object? data) async {
    if (completer.isCompleted) return;
    if (data is! String) return;
    Object? parsed;
    try {
      parsed = jsonDecode(data);
    } catch (_) {
      return;
    }
    if (parsed is! Map) return;
    final frame = Map<String, dynamic>.from(parsed);
    if (frame['t'] == 'welcome') {
      if (frame['ok'] != true) {
        fail(frame['message'] is String
            ? frame['message'] as String
            : 'The relay refused the pairing connection.');
        return;
      }
      socket?.sink.add(jsonEncode({
        't': 'to',
        'frame': {'t': 'pair', 'proof': proof, 'name': name, 'platform': guessPlatform()},
      }));
      return;
    }
    if (frame['t'] != 'from') return;
    final inner = frame['frame'];
    if (inner is! Map) return;
    if (inner['t'] == 'pair-error') {
      fail(inner['reason'] is String
          ? inner['reason'] as String
          : 'The desktop refused the pairing.');
      return;
    }
    if (inner['t'] == 'sec') {
      Object? opened;
      try {
        opened = await openFrame(key, Map<String, dynamic>.from(inner));
      } catch (e) {
        fail('Pairing reply could not be decrypted ($e).');
        return;
      }
      if (opened is Map && opened['t'] == 'paired') {
        succeed(PairingSuccess(
          deviceId: opened['deviceId'] is String ? opened['deviceId'] as String : '',
          token: opened['token'] is String ? opened['token'] as String : '',
          desktopName:
              opened['desktopName'] is String ? opened['desktopName'] as String : 'Desktop',
          keyBase64: keyToBase64(keyBytes),
        ));
      }
    }
  }

  try {
    await socket.ready;
    if (completer.isCompleted) {
      timeout.cancel();
      throw const PairingException('Pairing was cancelled.');
    }
    socket.sink.add(jsonEncode({
      'v': remoteProtocolVersion,
      't': 'hello',
      'role': 'pairing',
      'desktopId': desktopId,
    }));
    final subscription = socket.stream.listen(
      (data) => unawaited(onMessage(data)),
      onError: (Object e) => fail('Could not reach the relay.'),
      onDone: () => fail('The relay closed the pairing connection.'),
    );
    final success = await completer.future;
    timeout.cancel();
    await subscription.cancel();
    return success;
  } on PairingException {
    timeout.cancel();
    rethrow;
  } catch (e) {
    timeout.cancel();
    throw PairingException('Could not reach the relay.');
  }
}
