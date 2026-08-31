import 'package:flutter/material.dart';

import '../main.dart';
import '../state/app_store.dart';
import '../state/tunnel.dart';
import 'scan_screen.dart';

/// The gate: pairing, errors and the unpaired state. After a successful scan
/// the pairing exchange runs over the relay; the identity is stored and the
/// tunnel takes over.
class PairScreen extends StatelessWidget {
  const PairScreen({super.key, required this.store});

  final AppStore store;

  Future<void> _scanQr(BuildContext context) async {
    final payload = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(builder: (_) => const ScanScreen()),
    );
    if (payload != null) {
      await store.pairWithQr(payload);
    }
  }

  Future<void> _manualEntry(BuildContext context) async {
    final relay = TextEditingController();
    final desktop = TextEditingController();
    final secret = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: Palette.surface,
        title: const Text('Manual pairing'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Fill in the values from the desktop pairing QR '
                '(Settings → Bridges → Remote access).',
                style: TextStyle(color: Palette.muted, fontSize: 12),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: relay,
                decoration: const InputDecoration(labelText: 'Relay URL'),
                autocorrect: false,
              ),
              const SizedBox(height: 8),
              TextField(
                controller: desktop,
                decoration: const InputDecoration(labelText: 'Desktop ID'),
                autocorrect: false,
              ),
              const SizedBox(height: 8),
              TextField(
                controller: secret,
                decoration: const InputDecoration(labelText: 'Pairing secret (p=…)'),
                autocorrect: false,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Pair'),
          ),
        ],
      ),
    );
    if (ok == true) {
      final fragment = Uri(
        fragment: Uri(
          queryParameters: {
            'p': secret.text.trim(),
            'relay': relay.text.trim(),
            'desktop': desktop.text.trim(),
          },
        ).query,
      ).toString();
      await store.pairWithQr('grasberg:$fragment');
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final state = store.tunnelState;
        final error = store.tunnelError;
        return Scaffold(
          body: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'Grasberg',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 32,
                      fontWeight: FontWeight.w600,
                      color: Palette.text,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Remote access',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Palette.muted),
                  ),
                  const SizedBox(height: 32),
                  if (state == TunnelState.pairing) ...[
                    const Center(child: CircularProgressIndicator()),
                    const SizedBox(height: 16),
                    const Text(
                      'Pairing with your desktop…',
                      textAlign: TextAlign.center,
                    ),
                  ] else ...[
                    if (state == TunnelState.error && error != null)
                      Container(
                        padding: const EdgeInsets.all(12),
                        margin: const EdgeInsets.only(bottom: 16),
                        decoration: BoxDecoration(
                          color: const Color(0xFF3A1D1D),
                          border: Border.all(color: const Color(0xFF6E2C2C)),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          error,
                          style: const TextStyle(color: Palette.errorColor, fontSize: 13),
                        ),
                      ),
                    if (state == TunnelState.unpaired)
                      const Padding(
                        padding: EdgeInsets.only(bottom: 24),
                        child: Text(
                          'Pair this phone with your desktop: open '
                          'Settings → Bridges → Remote access in the desktop '
                          'app and scan the QR code it shows.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Palette.muted, height: 1.4),
                        ),
                      ),
                    FilledButton.icon(
                      onPressed:
                          state == TunnelState.unpaired ? () => _scanQr(context) : null,
                      icon: const Icon(Icons.qr_code_scanner),
                      label: const Text('Scan QR code'),
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton(
                      onPressed:
                          state == TunnelState.unpaired ? () => _manualEntry(context) : null,
                      child: const Text('Enter manually'),
                    ),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
