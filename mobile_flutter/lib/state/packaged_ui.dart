import 'dart:io';
import 'package:flutter/services.dart';
import 'drafts.dart';

/// Serves only bundled assets on loopback. Never serves desktop data or keys.
/// A per-launch random path prevents other pages from addressing the bundle.
class PackagedUi {
  PackagedUi({Future<ByteData> Function(String)? load})
    : _load = load ?? rootBundle.load;
  final Future<ByteData> Function(String) _load;
  final String nonce = '${newSendId()}${newSendId()}';
  HttpServer? _server;
  Uri? entry;
  Future<Uri> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server = server;
    entry = Uri.parse(
      'http://127.0.0.1:${server.port}/$nonce/index.html?native=1#bridge=$nonce',
    );
    server.listen(_serve);
    return entry!;
  }

  bool owns(String url) {
    final uri = Uri.tryParse(url);
    return uri != null &&
        entry != null &&
        uri.origin == entry!.origin &&
        uri.path == entry!.path;
  }

  Future<void> _serve(HttpRequest request) async {
    final response = request.response;
    try {
      final segments = request.uri.pathSegments;
      if (request.method != 'GET' ||
          request.headers.value('host') != '127.0.0.1:${_server?.port}' ||
          segments.length < 2 ||
          segments.first != nonce ||
          segments
              .skip(1)
              .any(
                (s) =>
                    s.isEmpty ||
                    s == '.' ||
                    s == '..' ||
                    s.contains('/') ||
                    s.contains('\\'),
              )) {
        response.statusCode = HttpStatus.notFound;
        return;
      }
      final asset = segments.skip(1).join('/');
      if (asset != 'index.html' && !asset.startsWith('assets/')) {
        response.statusCode = HttpStatus.notFound;
        return;
      }
      final data = await _load('assets/ui/$asset');
      final extension = asset.split('.').last;
      const types = {
        'html': 'text/html; charset=utf-8',
        'js': 'text/javascript; charset=utf-8',
        'css': 'text/css; charset=utf-8',
        'svg': 'image/svg+xml',
        'png': 'image/png',
        'woff': 'font/woff',
        'woff2': 'font/woff2',
        'ttf': 'font/ttf',
        'wasm': 'application/wasm',
      };
      response.headers.set(
        'Content-Type',
        types[extension] ?? 'application/octet-stream',
      );
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('X-Frame-Options', 'DENY');
      response.add(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      );
    } catch (_) {
      response.statusCode = HttpStatus.notFound;
    } finally {
      await response.close();
    }
  }

  Future<void> close() async {
    await _server?.close(force: true);
    _server = null;
  }
}
