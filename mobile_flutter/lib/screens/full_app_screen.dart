import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import '../state/app_store.dart';
import '../state/packaged_ui.dart';
import '../state/rich_drafts.dart';

/// Full app UI is shipped with the native app. The relay supplies data only.
class FullAppScreen extends StatefulWidget {
  const FullAppScreen({super.key, required this.store});
  final AppStore store;
  @override
  State<FullAppScreen> createState() => _FullAppScreenState();
}

class _FullAppScreenState extends State<FullAppScreen> {
  final _assets = PackagedUi();
  final _drafts = RichDrafts();
  final _inFlight = <String>{};
  WebViewController? _controller;
  String? _error;
  bool _ready = false;
  bool? _online;
  late final String _deviceId;

  @override
  void initState() {
    super.initState();
    _deviceId = widget.store.identity!.deviceId;
    widget.store.remoteListeners.add(_push);
    widget.store.addListener(_connection);
    unawaited(_start());
  }

  bool get _authorized =>
      mounted &&
      widget.store.hasFullAccess &&
      widget.store.identity?.deviceId == _deviceId;

  Future<void> _start() async {
    try {
      final entry = await _assets.start();
      if (!mounted) {
        await _assets.close();
        return;
      }
      final controller = WebViewController(
        onPermissionRequest: (request) async {
          // The shared UI only needs microphone capture; previews get no device permissions.
          if (!_authorized ||
              request.types.length != 1 ||
              !request.types.contains(
                WebViewPermissionResourceType.microphone,
              )) {
            await request.deny();
            return;
          }
          if (await Permission.microphone.request().isGranted && _authorized) {
            await request.grant();
          } else {
            await request.deny();
            widget.store.setToast(
              'Microphone access is off. Enable it in your phone settings to dictate.',
            );
          }
        },
      );
      _controller = controller;
      await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await controller.setBackgroundColor(const Color(0xFF14171B));
      await controller.addJavaScriptChannel(
        'GrasbergNative',
        onMessageReceived: (message) {
          unawaited(_message(message.message));
        },
      );
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (navigation) {
            if (!navigation.isMainFrame) return NavigationDecision.navigate;
            if (_assets.owns(navigation.url)) {
              return NavigationDecision.navigate;
            }
            final uri = Uri.tryParse(navigation.url);
            if (uri != null && ['https', 'http'].contains(uri.scheme)) {
              unawaited(launchUrl(uri, mode: LaunchMode.externalApplication));
            }
            return NavigationDecision.prevent;
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame == true && mounted) {
              setState(
                () => _error =
                    'The app interface could not load. Close this view and try again.',
              );
            }
          },
        ),
      );
      if (controller.platform case final AndroidWebViewController android) {
        await android.setGeolocationEnabled(false);
        await android.setOnShowFileSelector((params) async {
          if (!_authorized) return [];
          final result = await FilePicker.platform.pickFiles(
            allowMultiple: params.mode == FileSelectorMode.openMultiple,
          );
          return result?.files
                  .where((f) => f.path != null)
                  .map((f) => Uri.file(f.path!).toString())
                  .toList() ??
              [];
        });
      }
      await controller.loadRequest(entry);
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'The packaged app interface is unavailable. Reinstall the current mobile build.',
        );
      }
    }
  }

  Future<void> _emit(Map<String, Object?> message) async {
    if (!_authorized || !_ready) return;
    try {
      // jsonEncode produces one data literal; no received text is executable code.
      await _controller?.runJavaScript(
        'window.__grasbergReceive?.(${jsonEncode({'nonce': _assets.nonce, ...message})})',
      );
    } catch (_) {
      /* WebView may have been disposed during a reconnect. */
    }
  }

  void _push(String channel, Object? payload) {
    unawaited(_emit({'channel': channel, 'payload': payload}));
  }

  void _connection() {
    if (_online == widget.store.isConnected) return;
    _online = widget.store.isConnected;
    _push('client:connection', _online);
  }

  Future<void> _message(String raw) async {
    if (!_authorized || raw.length > 8 * 1024 * 1024) return;
    String? id;
    try {
      final message = jsonDecode(raw);
      if (message is! Map ||
          message['nonce'] != _assets.nonce ||
          message['id'] is! String ||
          message['channel'] is! String ||
          message['args'] is! List) {
        return;
      }
      id = message['id'] as String;
      if (id.length > 64 || _inFlight.length >= 64 || !_inFlight.add(id)) {
        return;
      }
      if (!_assets.owns(await _controller?.currentUrl() ?? '')) return;
      if (!_authorized) return;
      final channel = message['channel'] as String;
      final args = List<Object?>.from(message['args'] as List);
      if (channel == 'client:ready') _ready = true;
      final data = await _invoke(channel, args);
      await _emit({'id': id, 'result': data});
    } catch (error) {
      await _emit({
        'id': id,
        'result': {
          'ok': false,
          'error': {
            'code': 'unknown',
            'message': error is FormatException
                ? error.message
                : 'This action could not complete. Your edits have been kept; please retry.',
            'retryable': true,
          },
        },
      });
    } finally {
      if (id != null) _inFlight.remove(id);
    }
  }

  Future<Map<String, Object?>> _invoke(
    String channel,
    List<Object?> args,
  ) async {
    if (!_authorized) {
      throw const FormatException('Full access was removed on the desktop.');
    }
    Object? data;
    switch (channel) {
      case 'client:ready':
        data = {
          'capabilities': widget.store.capabilities,
          'online': widget.store.isConnected,
        };
      case 'client:device':
        widget.store.setCompact(true);
      case 'client:draftGet':
        data = await _drafts.get(_deviceId, args.single as String);
      case 'client:draftSave':
        final input = args.single as Map;
        await _drafts.save(
          _deviceId,
          input['conversationId'] as String,
          input['draft'],
        );
      case 'client:saveDownload':
        data = await _download(Map<String, Object?>.from(args.single as Map));
      default:
        final channels = widget.store.capabilities?['requestChannels'];
        if (channels is! List || !channels.contains(channel)) {
          throw const FormatException(
            'This feature needs a newer desktop version or full device access.',
          );
        }
        final result = await widget.store.invokeRemote(channel, args);
        if (!result.ok) {
          return {
            'ok': false,
            'error': {
              'code': result.error!.code,
              'message': result.error!.message,
              'retryable': result.error!.retryable,
            },
          };
        }
        data = result.data;
    }
    return {'ok': true, 'data': data};
  }

  Future<Object?> _download(Map<String, Object?> transfer) async {
    final id = transfer['id'] as String;
    final name = transfer['name'] as String;
    final size = transfer['size'] as int;
    if (size < 0 ||
        size > 64 * 1024 * 1024 ||
        name.isEmpty ||
        name.contains(RegExp(r'[\\/\x00-\x1f]'))) {
      throw const FormatException('Invalid download.');
    }
    final bytes = BytesBuilder(copy: false);
    try {
      while (bytes.length < size) {
        if (!_authorized) {
          throw const FormatException('Full access was removed.');
        }
        final result = await widget.store.invokeRemote('remote:download:read', [
          {'id': id, 'offset': bytes.length},
        ]);
        if (!result.ok) throw FormatException(result.error!.message);
        final part = result.data as Map;
        final chunk = base64Decode(part['data'] as String);
        if (chunk.isEmpty ||
            chunk.length > 128 * 1024 ||
            part['next'] != bytes.length + chunk.length ||
            bytes.length + chunk.length > size) {
          throw const FormatException(
            'The download was interrupted. Export again.',
          );
        }
        bytes.add(chunk);
      }
      if (!_authorized) throw const FormatException('Full access was removed.');
      final path = await FilePicker.platform.saveFile(
        dialogTitle: 'Save export',
        fileName: name,
        bytes: bytes.takeBytes(),
      );
      return {'canceled': path == null};
    } finally {
      await widget.store.invokeRemote('remote:transfer:cancel', [id]);
    }
  }

  @override
  void dispose() {
    widget.store.remoteListeners.remove(_push);
    widget.store.removeListener(_connection);
    unawaited(_assets.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        if (_error != null || controller == null || !_ready) {
          widget.store.setCompact(true);
        } else if (_authorized) {
          unawaited(
            controller.runJavaScript(
              'window.dispatchEvent(new Event("grasberg-native-back"))',
            ),
          );
        }
      },
      child: Scaffold(
        body: SafeArea(
          child: _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: () => widget.store.setCompact(true),
                          child: const Text('Back to device'),
                        ),
                      ],
                    ),
                  ),
                )
              : controller == null
              ? const Center(child: CircularProgressIndicator())
              : WebViewWidget(controller: controller),
        ),
      ),
    );
  }
}
