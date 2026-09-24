import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:grasberg_mobile/state/rich_drafts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('forgetting one device waits for pending rich draft writes and preserves other devices', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final editor = RichDrafts();
    final secondEditor = RichDrafts();
    final one = editor.save('phone-one', 'chat', {'text': 'first'});
    final two = secondEditor.save('phone-one', 'chat', {'text': 'latest'});
    final other = editor.save('phone-two', 'chat', {'text': 'keep'});
    final clear = RichDrafts().clear('phone-one');
    await Future.wait([one, two, other, clear]);
    expect(await editor.get('phone-one', 'chat'), isNull);
    expect(await editor.get('phone-two', 'chat'), {'text': 'keep'});
  });
}
