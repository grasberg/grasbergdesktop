// Store tests: push handling without a live relay. The tunnel contract says
// "pushes are hints; requests are truth" — these tests pin the store's
// reduction rules for every push channel the phone acts on.

import 'package:flutter_test/flutter_test.dart';
import 'dart:async';
import 'package:grasberg_mobile/models/models.dart';
import 'package:grasberg_mobile/state/app_store.dart';
import 'package:grasberg_mobile/state/channels.dart';
import 'package:grasberg_mobile/state/tunnel.dart';

/// In-memory stand-in for the secure-storage-backed store (the interface is
/// what AppStore depends on, not the platform plugin).
class FakeIdentityStore implements IdentityStore {
  FakeIdentityStore([Identity? initial]) : _identity = initial;

  Identity? _identity;
  int saveCount = 0;

  @override
  Future<Identity?> load() async => _identity;

  @override
  Future<void> save(Identity identity) async {
    _identity = identity;
    saveCount += 1;
  }

  @override
  Future<void> clear() async => _identity = null;
}

AppStore makeStore() => AppStore(identityStore: FakeIdentityStore());

/// Raw decoded JSON, exactly what the tunnel hands to handlePush.
Map<String, Object?> envelopeJson(Map<String, dynamic> event, {String streamId = 's1'}) =>
    <String, Object?>{
      'streamId': streamId,
      'conversationId': 'conv-1',
      'event': event,
    };

void main() {
  test('failed sends retain drafts and reuse the same id without duplicate clicks', () async {
    final delivery = Completer<IpcResult<Object?>>();
    final requests = <List<Object?>>[];
    final store = AppStore(identityStore: FakeIdentityStore(), requestOverride: (channel, args) async {
      requests.add(args);
      return requests.length == 1 ? delivery.future : IpcResult.ok({'queued': true, 'userMessage': {'id': 'u', 'role': 'user'}});
    });
    store.currentId = 'c'; store.setDraft('c', 'hello');
    final first = store.sendMessage('hello');
    expect(await store.sendMessage('hello'), isFalse);
    delivery.complete(IpcResult.err(IpcError(code: 'network', message: 'offline', retryable: true)));
    expect(await first, isFalse);
    expect(store.drafts['c'], 'hello');
    expect(await store.sendMessage('hello'), isTrue);
    expect((requests[0][0] as Map)['clientRequestId'], (requests[1][0] as Map)['clientRequestId']);
    expect(store.drafts['c'], isNull);
    store.dispose();
  });

  test('pending recovery replays settlements and new questions received in flight', () async {
    final snapshot = Completer<IpcResult<Object?>>();
    final store = AppStore(identityStore: FakeIdentityStore(), requestOverride: (_, _) => snapshot.future);
    final recovery = store.syncPending();
    await Future<void>.delayed(Duration.zero);
    store.handlePush(Channels.toolApprovalSettled, 'old');
    store.handlePush(Channels.userQuestionRequest, {'requestId': 'new', 'question': 'Continue?'});
    snapshot.complete(IpcResult.ok({'approvals': [{'requestId': 'old'}], 'questions': []}));
    await recovery;
    expect(store.approvals, isEmpty);
    expect(store.questions.single.requestId, 'new');
    store.dispose();
  });

  test('a terminal event before the send reply never leaves a ghost stream', () {
    final store = makeStore();
    store.handlePush(Channels.streamEvent, envelopeJson({'type': 'done'}));
    store.applySendResult('conv-1', {'streamId': 's1', 'userMessage': {'id': 'u'}, 'assistantMessage': {'id': 'a'}});
    expect(store.streams, isEmpty);
    store.dispose();
  });

  test('queued sends keep one user message and adopt the drained stream', () {
    final store = makeStore();
    store.currentId = 'conv-1';
    final reply = <String, Object?>{'queued': true, 'userMessage': {'id': 'u', 'role': 'user', 'content': 'queued'}};
    store.applySendResult('conv-1', reply);
    store.applySendResult('conv-1', reply);
    expect(store.messages.map((m) => m.id).toList(), ['u']);
    expect(store.streams, isEmpty);
    store.handlePush(Channels.streamEvent, envelopeJson({'type': 'text-delta', 'text': 'Reply'}));
    expect(store.streams['s1']!.text, 'Reply');
    store.currentId = 'elsewhere';
    store.messages = [];
    store.applySendResult('conv-1', reply);
    expect(store.messages, isEmpty);
    store.dispose();
  });

  test('normal send replies deduplicate pushes and preserve early deltas', () {
    final store = makeStore();
    store.currentId = 'conv-1';
    store.handlePush(Channels.streamEvent, envelopeJson({'type': 'text-delta', 'text': 'Early'}));
    final reply = <String, Object?>{'streamId': 's1', 'userMessage': {'id': 'u'}, 'assistantMessage': {'id': 'a'}};
    store.applySendResult('conv-1', reply);
    store.applySendResult('conv-1', reply);
    expect(store.messages.map((m) => m.id).toList(), ['u', 'a']);
    expect(store.streams['s1']!.text, 'Early');
    store.dispose();
  });

  group('AppStore push handling', () {
    test('__hello__ records the desktop version', () {
      final store = makeStore();
      store.handlePush('__hello__', {'name': 'Grasberg', 'version': '9.9.9'});
      expect(store.appVersion, '9.9.9');
      store.dispose();
    });

    test('deltas accumulate only into known streams', () {
      final store = makeStore();
      store.streams['s1'] = StreamState(conversationId: 'conv-1');

      store.handlePush(
        Channels.streamEvent,
        envelopeJson({'type': 'text-delta', 'text': 'Hej'}),
      );
      store.handlePush(
        Channels.streamEvent,
        envelopeJson({'type': 'reasoning-delta', 'text': 'tänker'}),
      );
      // Unknown stream: ignored, never created.
      store.handlePush(
        Channels.streamEvent,
        envelopeJson({'type': 'text-delta', 'text': 'spöke'}, streamId: 'ghost'),
      );

      expect(store.streams['s1']!.text, 'Hej');
      expect(store.streams['s1']!.reasoning, 'tänker');
      expect(store.streams.containsKey('ghost'), isFalse);
      store.dispose();
    });

    test('failover resets partial text but keeps the stream', () {
      final store = makeStore();
      final stream = StreamState(conversationId: 'conv-1', text: 'halvt svar');
      store.streams['s1'] = stream;

      store.handlePush(
        Channels.streamEvent,
        envelopeJson({'type': 'failover', 'message': {'id': 'm1'}}),
      );

      expect(stream.text, '');
      expect(store.streams.containsKey('s1'), isTrue);
      store.dispose();
    });

    test('done finalizes the stream and surfaces the error toast on error', () {
      final store = makeStore();
      store.currentId = 'conv-1';
      store.streams['s1'] = StreamState(conversationId: 'conv-1', text: 'partial');

      // No tunnel is connected, so the re-fetch resolves to a network error —
      // harmless, and exactly what happens on a real reconnect.
      store.handlePush(Channels.streamEvent, envelopeJson({
        'type': 'error',
        'error': {'code': 'timeout', 'message': 'Provider timeout', 'retryable': true},
        'message': {'id': 'm1'},
      }));

      expect(store.streams.containsKey('s1'), isFalse);
      expect(store.toast, 'Provider timeout');
      store.dispose();
    });

    test('approvals upsert by requestId and clear on settle', () {
      final store = makeStore();
      final request = {
        'requestId': 'r1',
        'streamId': 's1',
        'conversationId': 'conv-1',
        'toolCall': {'name': 'run_shell_command', 'arguments': '{"command":"dir"}'},
        'risk': 'high',
      };

      store.handlePush(Channels.toolApprovalRequest, request);
      store.handlePush(Channels.toolApprovalRequest, {
        ...request,
        'risk': 'medium', // duplicate delivery → upsert, not append
      });
      expect(store.approvals.length, 1);
      expect(store.approvals.single.risk, 'medium');

      store.handlePush(Channels.toolApprovalSettled, 'r1');
      expect(store.approvals, isEmpty);
      store.dispose();
    });

    test('questions upsert by requestId and clear on settle', () {
      final store = makeStore();
      final request = {
        'requestId': 'q1',
        'streamId': 's1',
        'conversationId': 'conv-1',
        'question': 'Vilken?',
        'options': ['A', 'B'],
      };

      store.handlePush(Channels.userQuestionRequest, request);
      expect(store.questions.single.question, 'Vilken?');

      store.handlePush(Channels.userQuestionSettled, 'q1');
      expect(store.questions, isEmpty);
      store.dispose();
    });

    test('mainNotice surfaces a transient toast', () {
      final store = makeStore();
      store.handlePush(Channels.mainNotice, {'message': 'Kopierat'});
      expect(store.toast, 'Kopierat');
      store.dispose();
    });

    test('respondApproval keeps the card when the answer fails to send',
        () async {
      final store = makeStore();
      store.approvals = [
        ToolApprovalRequest(
          requestId: 'r1',
          streamId: 's1',
          conversationId: 'conv-1',
          toolName: 'browser',
          toolArguments: '{}',
          risk: 'medium',
        ),
      ];
      await store.respondApproval('r1', false);
      expect(store.approvals.single.requestId, 'r1');
      // No tunnel → the respond request failed → user sees why.
      expect(store.toast, isNotNull);
      store.dispose();
    });

    test('forgetDevice clears everything and lands on the pairing gate', () async {
      final store = makeStore();
      store.appVersion = '1.0.0';
      store.conversations = [];
      store.currentId = 'conv-1';

      store.forgetDevice();

      expect(store.tunnelState, TunnelState.unpaired);
      expect(store.appVersion, isNull);
      expect(store.currentId, isNull);
      store.dispose();
    });
  });

  group('AppStore init', () {
    test('no stored identity → unpaired gate', () async {
      final store = AppStore(identityStore: FakeIdentityStore());
      await store.init();
      expect(store.tunnelState, TunnelState.unpaired);
      expect(store.identity, isNull);
      store.dispose();
    });
  });
}
