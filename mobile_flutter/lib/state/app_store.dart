/// The mobile app's single store: connection state, conversation list, the
/// open conversation with live streaming, and the interactive cards (tool
/// approvals / model questions) that follow the user between views.
///
/// The Dart port of src/mobile/store.ts. Pushes are hints; requests are truth
/// — on every reconnect or 'changed' push the affected data is re-fetched, so
/// a dropped frame never leaves the UI stale (and the desktop needs no replay
/// buffer).
/// buffer).
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/models.dart';
import '../protocol/urls.dart';
import 'channels.dart';
import 'pairing.dart';
import 'tunnel.dart';

/// Live partial output of one in-flight generation.
class StreamState {
  StreamState({required this.conversationId, this.text = '', this.reasoning = ''});

  final String conversationId;
  String text;
  String reasoning;
}

class AppStore extends ChangeNotifier {
  AppStore({IdentityStore? identityStore})
      : identityStore = identityStore ?? IdentityStore();

  final IdentityStore identityStore;

  TunnelState tunnelState = TunnelState.connecting;
  String? tunnelError;
  String? appVersion;
  String? desktopName;
  Identity? identity;

  List<ConversationSummary> conversations = [];
  bool conversationsLoading = false;

  String? currentId;
  Conversation? conversation;
  List<Message> messages = [];
  final Map<String, StreamState> streams = {};

  List<ToolApprovalRequest> approvals = [];
  List<UserQuestionRequest> questions = [];
  String? toast;

  Tunnel? _tunnel;
  bool _initStarted = false;
  bool _disposed = false;
  Timer? _toastTimer;

  /// Async refreshes can land after dispose (teardown while a stream
  /// finalizes) — a notify on a dead ChangeNotifier must not crash shutdown.
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _toastTimer?.cancel();
    _tunnel?.close();
    super.dispose();
  }

  // -- lifecycle ------------------------------------------------------------

  /// Loads the stored identity and connects; safe to call once at startup.
  Future<void> init() async {
    if (_initStarted) return;
    _initStarted = true;
    final stored = await identityStore.load();
    if (stored == null) {
      _setState(TunnelState.unpaired, null);
      return;
    }
    identity = stored;
    _startTunnel(stored);
  }

  /// Pairs with a scanned QR payload, then connects. Throws PairingException
  /// with a user-facing message on failure.
  Future<void> pairWithQr(String payload, {String? deviceName}) async {
    final qr = parsePairingQr(payload);
    if (qr == null) {
      _setState(TunnelState.error, 'This QR code is not a Grasberg pairing code.');
      return;
    }
    _setState(TunnelState.pairing, null);
    try {
      final paired = await pairOverRelay(qr.desktopId, qr.secret, qr.relayUrl,
          deviceName: deviceName);
      final stored = Identity(
        relayUrl: qr.relayUrl,
        desktopId: qr.desktopId,
        deviceId: paired.deviceId,
        token: paired.token,
        keyBase64: paired.keyBase64,
      );
      await identityStore.save(stored);
      desktopName = paired.desktopName;
      identity = stored;
      _setState(TunnelState.connecting, null);
      _startTunnel(stored);
    } on PairingException catch (e) {
      _setState(TunnelState.error, e.message);
    } catch (e) {
      _setState(TunnelState.error, 'Pairing failed: $e');
    }
  }

  void _startTunnel(Identity stored) {
    _tunnel?.close();
    _tunnel = Tunnel(
      stored,
      identityStore,
      (state, error) {
        _setState(state, error);
        if (state == TunnelState.online) {
          unawaited(refreshConversations());
        }
        _notify();
      },
      handlePush,
    );
    _tunnel!.connect();
  }

  void _setState(TunnelState state, String? error) {
    tunnelState = state;
    tunnelError = error;
    _notify();
  }

  // -- requests -------------------------------------------------------------

  Future<IpcResult<T>> _request<T>(String channel, List<Object?> args) async {
    final tunnel = _tunnel;
    if (tunnel == null) {
      return IpcResult<T>.err(IpcError(
        code: 'network',
        message: 'Not connected.',
        retryable: true,
      ));
    }
    return tunnel.request<T>(channel, args);
  }

  Future<void> refreshConversations() async {
    conversationsLoading = true;
    _notify();
    final result = await _request<List<Object?>>(Channels.convList, [
      <String, Object?>{},
    ]);
    if (result.ok && result.data != null) {
      conversations = result.data!.map(ConversationSummary.fromJson).toList();
    }
    conversationsLoading = false;
    _notify();
  }

  Future<void> openConversation(String id) async {
    currentId = id;
    messages = [];
    conversation = null;
    _notify();
    final results = await Future.wait([
      _request<Map<String, Object?>>(Channels.convGet, [id]),
      _request<List<Object?>>(Channels.convMessages, [id]),
    ]);
    if (currentId != id) return; // the user moved on
    final convResult = results[0] as IpcResult<Map<String, Object?>>;
    final msgResult = results[1] as IpcResult<List<Object?>>;
    if (convResult.ok && convResult.data != null) {
      conversation = Conversation.fromJson(convResult.data);
    }
    if (msgResult.ok && msgResult.data != null) {
      messages = msgResult.data!.map(Message.fromJson).toList();
    }
    _notify();
  }

  void closeConversation() {
    currentId = null;
    conversation = null;
    messages = [];
    _notify();
  }

  Future<void> newConversation() async {
    final result = await _request<Map<String, Object?>>(Channels.convCreate, [
      {'mode': 'chat', 'title': null},
    ]);
    if (!result.ok || result.data == null) {
      setToast(result.error?.message ?? 'Could not create the conversation.');
      return;
    }
    final created = Conversation.fromJson(result.data);
    await refreshConversations();
    await openConversation(created.id);
  }

  Future<void> deleteConversation(String id) async {
    final result = await _request<Object?>(Channels.convDelete, [id]);
    if (!result.ok) {
      setToast(result.error?.message ?? 'Could not delete the conversation.');
      return;
    }
    if (currentId == id) closeConversation();
    await refreshConversations();
  }

  Future<void> sendMessage(String text) async {
    final conversationId = currentId;
    final trimmed = text.trim();
    if (conversationId == null || trimmed.isEmpty) return;
    final result = await _request<Map<String, Object?>>(Channels.chatSend, [
      {'conversationId': conversationId, 'content': trimmed},
    ]);
    if (!result.ok || result.data == null) {
      setToast(result.error?.message ?? 'Could not send the message.');
      return;
    }
    final start = StartStreamResult.fromJson(result.data);
    messages = [...messages, ?start.userMessage, start.assistantMessage];
    streams[start.streamId] = StreamState(conversationId: conversationId);
    _notify();
  }

  Future<void> stopStream(String streamId) async {
    final result = await _request<Object?>(Channels.chatStop, [streamId]);
    if (!result.ok) setToast(result.error?.message ?? 'Could not stop the stream.');
  }

  Future<void> regenerate(String messageId) async {
    final conversationId = currentId;
    if (conversationId == null) return;
    final result = await _request<Map<String, Object?>>(Channels.chatRegenerate, [
      {'conversationId': conversationId, 'messageId': messageId},
    ]);
    if (!result.ok || result.data == null) {
      setToast(result.error?.message ?? 'Could not regenerate.');
      return;
    }
    await openConversation(conversationId);
    final start = StartStreamResult.fromJson(result.data);
    streams[start.streamId] = StreamState(conversationId: conversationId);
    _notify();
  }

  Future<void> respondApproval(String requestId, bool approved) async {
    approvals = approvals.where((a) => a.requestId != requestId).toList();
    _notify();
    final result = await _request<Object?>(Channels.toolsApprovalRespond, [
      requestId,
      approved,
      'once',
    ]);
    if (!result.ok) setToast(result.error?.message ?? 'Could not answer the approval.');
  }

  Future<void> respondQuestion(String requestId, String answer) async {
    questions = questions.where((q) => q.requestId != requestId).toList();
    _notify();
    final result = await _request<Object?>(Channels.toolsQuestionRespond, [
      requestId,
      answer,
    ]);
    if (!result.ok) setToast(result.error?.message ?? 'Could not answer the question.');
  }

  void forgetDevice() {
    _tunnel?.close();
    _tunnel = null;
    unawaited(identityStore.clear());
    identity = null;
    desktopName = null;
    appVersion = null;
    conversations = [];
    currentId = null;
    conversation = null;
    messages = [];
    streams.clear();
    approvals = [];
    questions = [];
    _setState(TunnelState.unpaired, null);
  }

  bool get isConnected => tunnelState == TunnelState.online;

  // -- pushes ---------------------------------------------------------------

  /// Dispatches one decrypted push from the tunnel. Public so tests can feed
  /// envelopes without a live relay connection.
  void handlePush(String channel, Object? payload) {
    if (channel == '__hello__') {
      final app = payload is Map ? Map<String, dynamic>.from(payload) : const {};
      appVersion = app['version'] is String ? app['version'] as String : null;
      _notify();
      return;
    }
    if (channel == Channels.streamEvent) {
      handleStreamEvent(StreamEventEnvelope.fromJson(payload));
      return;
    }
    switch (channel) {
      case Channels.conversationsChanged:
        unawaited(refreshConversations());
        final changed = payload is Map ? payload['conversationId'] : null;
        if (changed is String && changed == currentId) {
          unawaited(openConversation(changed));
        }
        break;
      case Channels.toolApprovalRequest:
        final request = ToolApprovalRequest.fromJson(payload);
        approvals = [
          ...approvals.where((a) => a.requestId != request.requestId),
          request,
        ];
        _notify();
        break;
      case Channels.toolApprovalSettled:
        final id = payload is String ? payload : null;
        approvals = approvals.where((a) => a.requestId != id).toList();
        _notify();
        break;
      case Channels.userQuestionRequest:
        final request = UserQuestionRequest.fromJson(payload);
        questions = [
          ...questions.where((q) => q.requestId != request.requestId),
          request,
        ];
        _notify();
        break;
      case Channels.userQuestionSettled:
        final id = payload is String ? payload : null;
        questions = questions.where((q) => q.requestId != id).toList();
        _notify();
        break;
      case Channels.mainNotice:
        final message = payload is Map ? payload['message'] : null;
        setToast(message is String ? message : null);
        break;
      default:
        break;
    }
  }

  /// Applies one stream envelope: deltas append, failover resets, done/error
  /// finalizes and re-fetches the persisted truth.
  void handleStreamEvent(StreamEventEnvelope envelope) {
    final current = streams[envelope.streamId];
    if (envelope.isDelta) {
      if (current == null) return;
      if (envelope.type == 'text-delta') {
        current.text = current.text + (envelope.text ?? '');
      } else {
        current.reasoning = current.reasoning + (envelope.text ?? '');
      }
      _notify();
      return;
    }
    if (envelope.type == 'failover') {
      // A fallback model restarts the answer: drop the failed attempt's
      // partial text so the phone doesn't concatenate two answers.
      if (current == null) return;
      current.text = '';
      current.reasoning = '';
      _notify();
      return;
    }
    if (envelope.isTerminal) {
      streams.remove(envelope.streamId);
      // Refresh with the persisted truth (final message, snippet, ordering).
      if (currentId == envelope.conversationId) {
        unawaited(openConversation(envelope.conversationId));
      }
      unawaited(refreshConversations());
      if (envelope.type == 'error') {
        setToast(envelope.errorMessage ?? 'Generation failed.');
      }
      _notify();
    }
  }

  // -- toast ----------------------------------------------------------------

  void setToast(String? message) {
    _toastTimer?.cancel();
    toast = message;
    _notify();
    if (message != null) {
      _toastTimer = Timer(const Duration(seconds: 4), () {
        toast = null;
        _notify();
      });
    }
  }

}
