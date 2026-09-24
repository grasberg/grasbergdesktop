import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:grasberg_mobile/state/packaged_ui.dart';

void main() {
  test(
    'serves packaged assets only under an unpredictable loopback path',
    () async {
      final loaded = <String>[];
      final server = PackagedUi(
        load: (path) async {
          loaded.add(path);
          return ByteData.sublistView(Uint8List.fromList([65, 66]));
        },
      );
      final client = HttpClient();
      try {
        final entry = await server.start();
        expect(entry.host, '127.0.0.1');
        final response = await (await client.getUrl(entry)).close();
        expect(response.statusCode, 200);
        await response.drain<void>();
        expect(loaded, ['assets/ui/index.html']);
        expect(server.owns(entry.toString()), isTrue);
        expect(server.owns('https://example.com/index.html'), isFalse);
        for (final path in [
          '/index.html',
          '/${server.nonce}/secret.json',
          '/${server.nonce}/../index.html',
        ]) {
          final blocked = await (await client.getUrl(
            entry.replace(path: path),
          )).close();
          expect(blocked.statusCode, 404);
          await blocked.drain<void>();
        }
        expect(loaded.length, 1);
      } finally {
        client.close(force: true);
        await server.close();
      }
    },
  );
}
