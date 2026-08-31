// One-shot tool for the reverse interop check: seals frames with the DART
// implementation and writes them to a file that tool/gen-interop-vectors.mjs
// (--verify) then opens with Node's WebCrypto. Run from mobile_flutter/:
//
//   dart run tool/dart-seal-verify.dart
//   node tool/gen-interop-vectors.mjs --verify test/fixtures/dart-sealed.json

import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:grasberg_mobile/protocol/crypto.dart';

Future<void> main() async {
  final fixture = jsonDecode(
    File('test/fixtures/interop.json').readAsStringSync(),
  ) as Map<String, dynamic>;
  final key = SecretKey(keyFromBase64(fixture['frameKeyBase64'] as String));

  final payloads = [
    {'t': 'hello'},
    {
      't': 'req',
      'id': 'dart-req-1',
      'seq': 42,
      'channel': 'chat:send',
      'args': [
        {'conversationId': 'conv-1', 'content': 'Hej från Flutter-appen'},
      ],
    },
    {
      't': 'push',
      'channel': 'push:streamEvent',
      'payload': {
        'streamId': 's1',
        'conversationId': 'conv-1',
        'event': {'type': 'text-delta', 'text': 'streamat från Dart'},
      },
    },
  ];

  final sealed = <Map<String, dynamic>>[];
  for (final payload in payloads) {
    sealed.add(await sealFrame(key, payload));
  }
  await File('test/fixtures/dart-sealed.json').writeAsString(
    jsonEncode({'payloads': payloads, 'sealed': sealed}, toEncodable: (v) => v.toString()),
  );
  stdout.writeln('sealed ${sealed.length} frames with the Dart implementation');
}
