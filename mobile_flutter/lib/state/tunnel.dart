/// The phone's tunnel: one WebSocket to the relay, speaking the frames in
/// src/shared/remote-protocol.ts — the Dart mirror of src/mobile/tunnel.ts.
///
/// Pushes are hints; requests are truth. The desktop sends no replay buffer,
/// so on every reconnect the store re-fetches whatever it displays.
/// library directive for the doc comment above.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/models.dart';
import '../protocol/constants.dart';
import '../protocol/crypto.dart';
import '../protocol/urls.dart';
import 'identity.dart';

export 'identity.dart' show Identity, IdentityStore;

enum TunnelState { unpaired, pairing, connecting, online, offline, error }

typedef OnState = void Function(TunnelState state, String? error);
typedef OnPush = void Function(String channel, Object? payload);

/// A request the desktop neither answers nor drops within this is dead.
const Duration _requestTimeout = Duration(seconds: 90);

class Tunnel {
  Tunnel(this.identity, this.identityStore, this.onState, this.onPush)
      : key = SecretKey(keyFromBase64(identity.keyBase64));

  TunnelState state = TunnelState.connecting;
  String? error;

  final Identity identity;
  final IdentityStore identityStore;
  final OnState onState;
  final OnPush onPush;
  final SecretKey key;

  WebSocketChannel? _socket;
  StreamSubscription<Object?>? _subscription;
  final Map<String, Completer<Map<String, dynamic>>> _pending = {};
  Timer? _reconnectTimer;
  int _failures = 0;
  bool _closedByUser = false;
  Future<void> _sendQueue = Future.value();

  /// Normalized ws endpoint for the saved relay URL.
  String? get _wsUrl => relayWsUrl(identity.relayUrl);

  void connect() {
    _closedByUser = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _setState(TunnelState.connecting, null);
    final url = _wsUrl;
    if (url == null) {
      _setState(TunnelState.error, 'The saved relay URL is invalid.');
      return;
    }
    final socket = WebSocketChannel.connect(Uri.parse(url));
    _socket = socket;
    // `ready` throwing is this transport's onerror; the close path runs from
    // the stream's completion/error below.
    socket.ready.then((_) {
      socket.sink.add(jsonEncode(_deviceHello()));
      _subscription = socket.stream.listen(
        (data) {
          if (data is String) _handleMessage(data);
        },
        onDone: () => _handleClose(socket.closeCode, socket.closeReason),
        onError: (Object _) => _handleClose(socket.closeCode, socket.closeReason),
      );
    }).catchError((Object e) {
      _handleClose(null, null);
    });
  }

  Map<String, Object> _deviceHello() => {
        'v': remoteProtocolVersion,
        't': 'hello',
        'role': 'device',
        'desktopId': identity.desktopId,
        'deviceId': identity.deviceId,
        'token': identity.token,
      };

  void close() {
    _closedByUser = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _subscription?.cancel();
    _subscription = null;
    try {
      _socket?.sink.close(1000);
    } catch (_) {
      // Already gone.
    }
    _socket = null;
  }

  /// Invokes one IPC channel on the desktop; resolves with its IpcResult.
  Future<IpcResult<T>> request<T>(String channel, List<Object?> args) async {
    final socket = _socket;
    if (socket == null || state != TunnelState.online) {
      return IpcResult<T>.err(IpcError(
        code: 'network',
        message: 'Not connected to the desktop.',
        retryable: true,
      ));
    }
    final id = randomUuid();
    final seq = identity.nextRequestSeq;
    identity.nextRequestSeq += 1;
    // Persist before network I/O: a crash may skip a number, but can never
    // reuse one the desktop might already have executed.
    await identityStore.save(identity);
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;
    final timer = Timer(_requestTimeout, () {
      if (identical(_pending[id], completer)) {
        _pending.remove(id);
        completer.complete({
          'ok': false,
          'error': {
            'code': 'timeout',
            'message': 'The desktop did not answer in time.',
            'retryable': true,
          },
        });
      }
    });
    // Serialize sends: the desktop accepts strictly increasing sequences, so
    // concurrent requests must seal and hit the wire in submission order.
    _sendQueue = _sendQueue.then((_) async {
      final sealed = await sealFrame(key, {
        't': 'req',
        'id': id,
        'seq': seq,
        'channel': channel,
        'args': args,
      });
      if (_socket != socket) {
        throw StateError('Connection lost before the request was sent.');
      }
      socket.sink.add(jsonEncode({'t': 'to', 'frame': sealed}));
    }).catchError((Object e) {
      if (identical(_pending[id], completer)) {
        _pending.remove(id);
        completer.complete({
          'ok': false,
          'error': {'code': 'network', 'message': 'Connection lost.', 'retryable': true},
        });
      }
      // Reset the queue so one failure does not poison later requests.
      _sendQueue = Future.value();
    });
    final result = await completer.future;
    timer.cancel();
    if (result['ok'] == true) {
      return IpcResult<T>.ok(result['data'] as T?);
    }
    return IpcResult<T>.err(IpcError.fromJson(result['error']));
  }

  void _setState(TunnelState state, String? error) {
    this.state = state;
    this.error = error;
    onState(state, error);
  }

  void _handleMessage(String raw) {
    Object? parsed;
    try {
      parsed = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (parsed is! Map) return;
    final frame = Map<String, dynamic>.from(parsed);
    switch (frame['t']) {
      case 'welcome':
        if (frame['ok'] == true) {
          // Sealed hello: confirms both sides hold the same frame key and
          // gives the app version for the header.
          _sendInner({'t': 'hello'});
        } else {
          _setState(
            TunnelState.error,
            frame['message'] is String
                ? frame['message'] as String
                : 'The relay refused this device.',
          );
        }
        return;
      case 'presence':
        if (frame['desktop'] == 'online') {
          _failures = 0;
          _setState(TunnelState.online, null);
          _sendInner({'t': 'hello'});
        } else {
          _setState(TunnelState.offline, null);
        }
        return;
      case 'from':
        final sealed = frame['frame'];
        if (sealed is! Map || sealed['t'] != 'sec') return;
        _openSealed(Map<String, dynamic>.from(sealed));
        return;
      default:
        return;
    }
  }

  Future<void> _openSealed(Map<String, dynamic> sealed) async {
    Object? inner;
    try {
      inner = await openFrame(key, sealed);
    } catch (_) {
      // Tampered or foreign ciphertext: ignore.
      return;
    }
    if (inner is! Map) return;
    final data = Map<String, dynamic>.from(inner);
    switch (data['t']) {
      case 'hello-res':
        _setState(TunnelState.online, null);
        onPush('__hello__', data['app']);
        return;
      case 'res':
        final id = data['id'];
        final pending = id is String ? _pending.remove(id) : null;
        if (pending != null && !pending.isCompleted) {
          final result = data['result'];
          pending.complete(
            result is Map ? Map<String, dynamic>.from(result) : {'ok': false},
          );
        }
        return;
      case 'push':
        onPush(data['channel'] is String ? data['channel'] as String : '', data['payload']);
        return;
      default:
        return;
    }
  }

  Future<void> _sendInner(Object? payload) async {
    final socket = _socket;
    if (socket == null) return;
    try {
      final sealed = await sealFrame(key, payload);
      if (_socket == socket) {
        socket.sink.add(jsonEncode({'t': 'to', 'frame': sealed}));
      }
    } catch (_) {
      // A dead socket is handled by its close path.
    }
  }

  Future<void> _handleClose(int? code, String? reason) async {
    for (final pending in _pending.values) {
      if (!pending.isCompleted) {
        pending.complete({
          'ok': false,
          'error': {'code': 'network', 'message': 'Connection lost.', 'retryable': true},
        });
      }
    }
    _pending.clear();
    _subscription?.cancel();
    _subscription = null;
    _socket = null;
    if (_closedByUser) return;
    if (code == 4401) {
      // Either revoked on the desktop, or the relay lost its registration.
      // Retrying THIS identity is pointless: drop it and tell the user.
      await identityStore.clear();
      _setState(
        TunnelState.unpaired,
        'This device is not authorized. It was revoked on the desktop, or the relay lost its '
            'registration — reconnecting the desktop re-syncs it. If it persists, pair again '
            'from Settings → Bridges.',
      );
      return;
    }
    _setState(TunnelState.offline, reason);
    final backoff = Duration(
      milliseconds: min(30000, 3000 * pow(2, min(_failures, 4)).toInt()),
    );
    _failures += 1;
    _reconnectTimer = Timer(backoff, connect);
  }
}
