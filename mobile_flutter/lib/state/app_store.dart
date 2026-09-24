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
import 'drafts.dart';
import 'rich_drafts.dart';

/// Live partial output of one in-flight generation.
class StreamState {
  StreamState({
    required this.conversationId,
    this.text = '',
    this.reasoning = '',
  });

  final String conversationId;
  String text;
  String reasoning;
}

class AppStore extends ChangeNotifier {
  AppStore({
    IdentityStore? identityStore,
    DraftStore? draftStore,
    this.requestOverride,
  }) : identityStore = identityStore ?? IdentityStore(),
       draftStore = draftStore ?? DraftStore();

  final IdentityStore identityStore;
  final DraftStore draftStore;
  final Future<IpcResult<Object?>> Function(String, List<Object?>)?
  requestOverride;
  final Map<String, String> drafts = {};
  final Map<String, PendingSend> sends = {};
  final Set<String> responding = {};
  Future<void> _draftWrite = Future.value();
  Future<void>? _pendingSync;
  final List<void Function()> _pendingChanges = [];

  TunnelState tunnelState = TunnelState.connecting;
  String? tunnelError;
  String? appVersion;
  Map<String, Object?>? capabilities;
  bool showCompact = false;
  final Set<void Function(String, Object?)> remoteListeners = {};
  bool get hasFullAccess => capabilities?['access'] == 'full';
  void setCompact(bool value) {
    showCompact = value;
    _notify();
  }

  Future<IpcResult<Object?>> invokeRemote(String channel, List<Object?> args) =>
      _request<Object?>(channel, args);
  Future<void> refreshCapabilities() async {
    final deviceId = identity?.deviceId;
    final result = await _request<Map<String, Object?>>(
      'remote:capabilities',
      [],
    );
    if (identity?.deviceId != deviceId) return;
    if (result.ok) {
      capabilities = result.data;
      _notify();
    }
  }

  String? desktopName;
  Identity? identity;

  List<ConversationSummary> conversations = [];
  bool conversationsLoading = false;

  String? currentId;
  Conversation? conversation;
  List<Message> messages = [];
  final Map<String, StreamState> streams = {};
  final Set<String> _finishedStreams = {};

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
    await restoreDrafts(stored.deviceId);
    _startTunnel(stored);
  }

  /// Pairs with a scanned QR payload, then connects. Throws PairingException
  /// with a user-facing message on failure.
  Future<void> pairWithQr(String payload, {String? deviceName}) async {
    final qr = parsePairingQr(payload);
    if (qr == null) {
      _setState(
        TunnelState.error,
        'This QR code is not a Grasberg pairing code.',
      );
      return;
    }
    _setState(TunnelState.pairing, null);
    try {
      final paired = await pairOverRelay(
        qr.desktopId,
        qr.secret,
        qr.relayUrl,
        deviceName: deviceName,
      );
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
    _tunnel = Tunnel(stored, identityStore, (state, error) {
      _setState(state, error);
      if (state == TunnelState.online) {
        unawaited(refreshCapabilities());
        unawaited(refreshConversations());
        unawaited(syncPending());
        if (currentId != null) unawaited(openConversation(currentId!));
      }
      _notify();
    }, handlePush);
    _tunnel!.connect();
  }

  void _setState(TunnelState state, String? error) {
    tunnelState = state;
    tunnelError = error;
    _notify();
  }

  // -- requests -------------------------------------------------------------

  Future<IpcResult<T>> _request<T>(String channel, List<Object?> args) async {
    try {
      return await _requestConnected<T>(channel, args);
    } catch (_) {
      return IpcResult<T>.err(
        IpcError(
          code: 'network',
          message: 'Connection interrupted. Reconnect and try again.',
          retryable: true,
        ),
      );
    }
  }

  Future<IpcResult<T>> _requestConnected<T>(
    String channel,
    List<Object?> args,
  ) async {
    if (requestOverride != null) {
      final result = await requestOverride!(channel, args);
      return result.ok
          ? IpcResult<T>.ok(result.data as T?)
          : IpcResult<T>.err(result.error);
    }
    final tunnel = _tunnel;
    if (tunnel == null) {
      return IpcResult<T>.err(
        IpcError(code: 'network', message: 'Not connected.', retryable: true),
      );
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

  Future<void> restoreDrafts(String deviceId) async {
    try {
      final data = await draftStore.load(deviceId);
      drafts.addAll(Map<String, String>.from(data['drafts'] as Map? ?? {}));
      for (final entry in (data['sends'] as Map? ?? {}).entries) {
        final send = entry.value as Map;
        if (send['requestId'] is String && send['text'] is String) {
          sends[entry.key as String] = PendingSend(
            send['requestId'],
            send['text'],
            error:
                'Delivery was not confirmed. Retry safely with the same message.',
          );
        }
      }
    } catch (_) {
      setToast('Saved drafts could not be restored.');
    }
  }

  void setDraft(String id, String text) {
    drafts[id] = text;
    unawaited(persistDrafts());
  }

  Future<void> persistDrafts() {
    final id = identity?.deviceId;
    if (id == null) return Future.value();
    final data = <String, dynamic>{
      'drafts': Map.of(drafts),
      'sends': sends.map((key, value) => MapEntry(key, value.toJson())),
    };
    _draftWrite = _draftWrite.then((_) => draftStore.save(id, data)).catchError((
      Object _,
    ) {
      setToast(
        'Device storage is unavailable. Keep the app open to preserve your draft.',
      );
    });
    return _draftWrite;
  }

  Future<void> syncPending() =>
      _pendingSync ??= Future.microtask(_fetchPending).whenComplete(() {
        _pendingSync = null;
        _pendingChanges.clear();
      });
  Future<void> _fetchPending() async {
    _pendingChanges.clear();
    final result = await _request<Map<String, Object?>>('tools:pending', []);
    if (result.ok && result.data != null) {
      approvals = (result.data!['approvals'] as List? ?? [])
          .map(ToolApprovalRequest.fromJson)
          .toList();
      questions = (result.data!['questions'] as List? ?? [])
          .map(UserQuestionRequest.fromJson)
          .toList();
      for (final change in _pendingChanges) {
        change();
      }
      _notify();
    }
  }

  Future<bool> sendMessage(String text) async {
    final conversationId = currentId;
    final trimmed = text.trim();
    if (conversationId == null ||
        trimmed.isEmpty ||
        sends[conversationId]?.sending == true) {
      return false;
    }
    final previous = sends[conversationId];
    final pending = PendingSend(
      previous?.text == trimmed ? previous!.requestId : newSendId(),
      trimmed,
      sending: true,
    );
    sends[conversationId] = pending;
    _notify();
    await persistDrafts();
    final result = await _request<Map<String, Object?>>(Channels.chatSend, [
      {
        'conversationId': conversationId,
        'content': trimmed,
        'clientRequestId': pending.requestId,
      },
    ]);
    if (!result.ok || result.data == null) {
      pending.sending = false;
      pending.error = result.error?.message ?? 'Could not send the message.';
      setToast(pending.error);
      return false;
    }
    sends.remove(conversationId);
    if (drafts[conversationId]?.trim() == trimmed) {
      drafts.remove(conversationId);
    }
    await persistDrafts();
    applySendResult(conversationId, result.data!);
    if (result.data!['replayed'] == true && currentId == conversationId) {
      await openConversation(conversationId);
    }
    return true;
  }

  void applySendResult(String conversationId, Map<String, Object?> data) {
    if (data['queued'] == true) {
      final user = Message.fromJson(data['userMessage']);
      if (currentId == conversationId &&
          !messages.any((m) => m.id == user.id)) {
        messages = [...messages, user];
      }
    } else {
      final start = StartStreamResult.fromJson(data);
      if (currentId == conversationId) {
        final incoming = [?start.userMessage, start.assistantMessage];
        messages = [
          ...messages,
          ...incoming.where(
            (m) => !messages.any((existing) => existing.id == m.id),
          ),
        ];
      }
      if (!_finishedStreams.contains(start.streamId)) {
        streams.putIfAbsent(
          start.streamId,
          () => StreamState(conversationId: conversationId),
        );
      }
    }
    _notify();
  }

  Future<void> stopStream(String streamId) async {
    final result = await _request<Object?>(Channels.chatStop, [streamId]);
    if (!result.ok) {
      setToast(result.error?.message ?? 'Could not stop the stream.');
    }
  }

  Future<void> regenerate(String messageId) async {
    final conversationId = currentId;
    if (conversationId == null) return;
    final result = await _request<Map<String, Object?>>(
      Channels.chatRegenerate,
      [
        {'conversationId': conversationId, 'messageId': messageId},
      ],
    );
    if (!result.ok || result.data == null) {
      setToast(result.error?.message ?? 'Could not regenerate.');
      return;
    }
    await openConversation(conversationId);
    final start = StartStreamResult.fromJson(result.data);
    if (_finishedStreams.contains(start.streamId)) return;
    streams[start.streamId] = StreamState(conversationId: conversationId);
    _notify();
  }

  Future<bool> respondApproval(String requestId, bool approved) async {
    if (!responding.add(requestId)) return false;
    _notify();
    final result = await _request<Object?>(Channels.toolsApprovalRespond, [
      requestId,
      approved,
      'once',
    ]);
    responding.remove(requestId);
    if (result.ok) handlePush(Channels.toolApprovalSettled, requestId);
    if (!result.ok) {
      setToast(result.error?.message ?? 'Could not answer the approval.');
    }
    _notify();
    return result.ok;
  }

  Future<bool> respondQuestion(String requestId, String answer) async {
    if (!responding.add(requestId)) return false;
    _notify();
    final result = await _request<Object?>(Channels.toolsQuestionRespond, [
      requestId,
      answer,
    ]);
    responding.remove(requestId);
    if (result.ok) handlePush(Channels.userQuestionSettled, requestId);
    if (!result.ok) {
      setToast(result.error?.message ?? 'Could not answer the question.');
    }
    _notify();
    return result.ok;
  }

  void forgetDevice() {
    _tunnel?.close();
    _tunnel = null;
    unawaited(identityStore.clear());
    final deviceId = identity?.deviceId;
    if (deviceId != null) {
      unawaited(_draftWrite.then((_) => draftStore.clear(deviceId)));
      unawaited(RichDrafts().clear(deviceId));
    }
    drafts.clear();
    sends.clear();
    responding.clear();
    identity = null;
    capabilities = null;
    showCompact = false;
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
    for (final listener in remoteListeners.toList()) {
      listener(channel, payload);
    }
    if (channel == 'push:remoteCapabilities' && payload is Map) {
      capabilities = Map<String, Object?>.from(payload);
      _notify();
      return;
    }
    if (_pendingSync != null &&
        [
          Channels.toolApprovalRequest,
          Channels.toolApprovalSettled,
          Channels.userQuestionRequest,
          Channels.userQuestionSettled,
        ].contains(channel)) {
      _pendingChanges.add(() => _applyPendingPush(channel, payload));
    }
    if (channel == '__hello__') {
      final app = payload is Map
          ? Map<String, dynamic>.from(payload)
          : const {};
      appVersion = app['version'] is String ? app['version'] as String : null;
      _notify();
      return;
    }
    if (channel == Channels.streamEvent) {
      handleStreamEvent(StreamEventEnvelope.fromJson(payload));
      return;
    }
    if (_applyPendingPush(channel, payload)) return;
    switch (channel) {
      case Channels.conversationsChanged:
        unawaited(refreshConversations());
        final changed = payload is Map ? payload['conversationId'] : null;
        if (changed is String && changed == currentId) {
          unawaited(openConversation(changed));
        }
        break;
      case Channels.mainNotice:
        final message = payload is Map ? payload['message'] : null;
        setToast(message is String ? message : null);
        break;
      default:
        break;
    }
  }

  bool _applyPendingPush(String channel, Object? payload) {
    switch (channel) {
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
      default:
        return false;
    }
    return true;
  }

  /// Applies one stream envelope: deltas append, failover resets, done/error
  /// finalizes and re-fetches the persisted truth.
  void handleStreamEvent(StreamEventEnvelope envelope) {
    if (_finishedStreams.contains(envelope.streamId)) return;
    final current =
        streams[envelope.streamId] ??
        (envelope.isDelta && currentId == envelope.conversationId
            ? streams.putIfAbsent(
                envelope.streamId,
                () => StreamState(conversationId: envelope.conversationId),
              )
            : null);
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
      _finishedStreams.add(envelope.streamId);
      if (_finishedStreams.length > 256) {
        _finishedStreams.remove(_finishedStreams.first);
      }
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
  }
}
