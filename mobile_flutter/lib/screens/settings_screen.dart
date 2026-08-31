import 'package:flutter/material.dart';

import '../main.dart';
import '../state/app_store.dart';
import '../state/tunnel.dart';

/// Paired-device info and the way out. Deliberately read-only otherwise:
/// settings (and pairing codes, provider keys) never travel to phones — the
/// desktop's router allowlist excludes those channels on principle.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key, required this.store});

  final AppStore store;

  Future<void> _forget(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: Palette.surface,
        title: const Text('Forget this device?'),
        content: const Text(
          'The stored identity and encryption key are deleted. To use this '
          'phone again, pair it again from the desktop (Settings → Bridges).',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Palette.errorColor),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Forget'),
          ),
        ],
      ),
    );
    if (ok == true) {
      store.forgetDevice();
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final identity = store.identity;
        final state = store.tunnelState;
        final stateLabel = switch (state) {
          TunnelState.online => 'Connected',
          TunnelState.offline => 'Desktop offline — reconnecting automatically',
          TunnelState.connecting => 'Connecting…',
          _ => 'Not connected',
        };
        return Scaffold(
          appBar: AppBar(title: const Text('Settings')),
          body: ListView(
            children: [
              const _Header('Connection'),
              ListTile(
                leading: Icon(
                  Icons.circle,
                  size: 12,
                  color: state == TunnelState.online
                      ? Palette.online
                      : state == TunnelState.offline || state == TunnelState.connecting
                          ? Palette.waiting
                          : Palette.muted,
                ),
                title: Text(stateLabel, style: const TextStyle(fontSize: 14)),
              ),
              if (store.appVersion != null)
                ListTile(
                  leading: const Icon(Icons.computer, size: 20),
                  title: const Text('Desktop', style: TextStyle(fontSize: 14)),
                  subtitle: Text('v${store.appVersion}', style: const TextStyle(fontSize: 12)),
                ),
              const Divider(),
              const _Header('Device'),
              _kv('Name', store.desktopName ?? 'Paired phone'),
              if (identity != null) ...[
                _kv('Device ID', identity.deviceId),
                _kv('Desktop ID', identity.desktopId),
                _kv('Relay', identity.relayUrl),
              ],
              const Divider(),
              Padding(
                padding: const EdgeInsets.all(16),
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(foregroundColor: Palette.errorColor),
                  onPressed: () => _forget(context),
                  icon: const Icon(Icons.link_off),
                  label: const Text('Forget this device'),
                ),
              ),
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  'Conversations stream from your desktop over an end-to-end '
                  'encrypted tunnel (AES-256-GCM). The relay only ever sees '
                  'ciphertext.',
                  style: TextStyle(color: Palette.muted, fontSize: 12, height: 1.4),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _kv(String key, String value) => ListTile(
        dense: true,
        title: Text(key, style: const TextStyle(fontSize: 13, color: Palette.muted)),
        subtitle: Text(
          value,
          style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
        ),
      );
}

class _Header extends StatelessWidget {
  const _Header(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        title.toUpperCase(),
        style: const TextStyle(
          color: Palette.muted,
          fontSize: 11,
          fontWeight: FontWeight.w600,
          letterSpacing: 1,
        ),
      ),
    );
  }
}
