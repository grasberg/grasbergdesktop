import 'package:flutter/material.dart';

import '../main.dart';
import '../models/models.dart';
import '../state/app_store.dart';
import 'settings_screen.dart';
import '../widgets/approval_cards.dart';

/// Conversation list + connection status bar + the interactive cards.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.store});

  final AppStore store;

  Future<void> _confirmDelete(BuildContext context, ConversationSummary summary) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: Palette.surface,
        title: const Text('Delete conversation?'),
        content: Text('“${summary.title.isEmpty ? 'Untitled' : summary.title}” is deleted '
            'together with its messages, also on the desktop.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Palette.errorColor),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok == true) {
      await store.deleteConversation(summary.id);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final conversations = store.conversations;
        final loading = store.conversationsLoading;
        return Scaffold(
          appBar: AppBar(
            title: const Text('Grasberg'),
            actions: [
              IconButton(
                icon: const Icon(Icons.settings_outlined),
                tooltip: 'Settings',
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => SettingsScreen(store: store)),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.add),
                tooltip: 'New conversation',
                onPressed: store.isConnected ? store.newConversation : null,
              ),
            ],
          ),
          body: SafeArea(
            child: Column(
              children: [
                ApprovalCards(store: store),
                Expanded(
                  child: loading && conversations.isEmpty
                      ? const Center(child: CircularProgressIndicator())
                      : conversations.isEmpty
                          ? const Center(
                              child: Padding(
                                padding: EdgeInsets.all(24),
                                child: Text(
                                  'No conversations yet. Start one, or use the desktop app.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(color: Palette.muted),
                                ),
                              ),
                            )
                          : ListView.builder(
                              itemCount: conversations.length,
                              itemBuilder: (context, index) {
                                final summary = conversations[index];
                                return _ConversationTile(
                                  summary: summary,
                                  onOpen: () => store.openConversation(summary.id),
                                  onDelete: () => _confirmDelete(context, summary),
                                );
                              },
                            ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _ConversationTile extends StatelessWidget {
  const _ConversationTile({required this.summary, required this.onOpen, required this.onDelete});

  final ConversationSummary summary;
  final VoidCallback onOpen;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onOpen,
      onLongPress: onDelete,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: Color(0xFF232930))),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    summary.title.isEmpty ? 'Untitled' : summary.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Palette.text,
                      fontWeight: FontWeight.w500,
                      fontSize: 15,
                    ),
                  ),
                  if (summary.snippet != null && summary.snippet!.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      summary.snippet!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Palette.muted, fontSize: 13),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              relativeTime(summary.updatedAt),
              style: const TextStyle(color: Palette.muted, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}

String relativeTime(int ts) {
  final diff = DateTime.now().millisecondsSinceEpoch - ts;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return '${diff ~/ 60000}m';
  if (diff < 86400000) return '${diff ~/ 3600000}h';
  return '${diff ~/ 86400000}d';
}
