import 'package:flutter/material.dart';

import '../main.dart';
import '../models/models.dart';
import '../state/app_store.dart';
import '../widgets/approval_cards.dart';
import '../widgets/message_bubble.dart';

/// One conversation: persisted messages, live streaming bubbles, approvals
/// and the composer — the phone view of the desktop's chat pipeline.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.store});

  final AppStore store;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final ScrollController _scroll = ScrollController();
  final TextEditingController _draft = TextEditingController();
  final FocusNode _focus = FocusNode();
  int _lastRenderLength = -1;

  AppStore get store => widget.store;

  @override
  void initState() {
    super.initState();
    // The send button's enabled state tracks the draft.
    _draft.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _scroll.dispose();
    _draft.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (!_scroll.hasClients) return;
    _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  void _maybeScroll(int renderLength) {
    if (renderLength != _lastRenderLength) {
      _lastRenderLength = renderLength;
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
    }
  }

  void _submit() {
    final text = _draft.text.trim();
    if (text.isEmpty) return;
    store.sendMessage(text);
    _draft.clear();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final currentId = store.currentId ?? '';
        final activeStreams = [
          ...store.streams.entries.where((e) => e.value.conversationId == currentId),
        ];
        final streaming = activeStreams.isNotEmpty;
        // The placeholder assistant message of a live stream would render as
        // an empty bubble; show only the live partial instead.
        final visibleMessages =
            store.messages.where((m) => !streaming || m.status != 'streaming').toList();
        final lastAssistant = visibleMessages
            .where((m) => m.role == 'assistant')
            .fold<Message?>(null, (acc, m) => m);
        final renderLength = visibleMessages.length +
            activeStreams.fold<int>(0, (sum, e) => sum + e.value.text.length);
        _maybeScroll(renderLength);

        return Scaffold(
          appBar: AppBar(
            leading: IconButton(
              icon: const Icon(Icons.arrow_back),
              onPressed: () => store.closeConversation(),
            ),
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  store.conversation?.title.isEmpty ?? true
                      ? 'Conversation'
                      : store.conversation!.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 16),
                ),
                if (store.conversation?.modelId != null)
                  Text(
                    store.conversation!.modelId!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Palette.muted, fontSize: 11),
                  ),
              ],
            ),
          ),
          body: SafeArea(
            child: Column(
              children: [
                ApprovalCards(store: store),
                Expanded(
                  child: ListView(
                    controller: _scroll,
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    children: [
                      for (final message in visibleMessages)
                        MessageBubble(message: message),
                      for (final entry in activeStreams)
                        MessageBubble(
                          message: Message(
                            id: entry.key,
                            conversationId: currentId,
                            role: 'assistant',
                            content: entry.value.text,
                            status: 'streaming',
                            reasoning: entry.value.reasoning.isEmpty
                                ? null
                                : entry.value.reasoning,
                            seq: 0,
                            createdAt: 0,
                          ),
                        ),
                    ],
                  ),
                ),
                const Divider(height: 1, color: Color(0xFF232930)),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                  child: streaming
                      ? SizedBox(
                          width: double.infinity,
                          child: OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: Palette.errorColor,
                            ),
                            onPressed: () => store.stopStream(activeStreams.first.key),
                            icon: const Icon(Icons.stop),
                            label: const Text('Stop generating'),
                          ),
                        )
                      : Column(
                          children: [
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                Expanded(
                                  child: TextField(
                                    controller: _draft,
                                    focusNode: _focus,
                                    minLines: 1,
                                    maxLines: 5,
                                    textInputAction: TextInputAction.newline,
                                    decoration: const InputDecoration(
                                      hintText: 'Message Grasberg…',
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                IconButton.filled(
                                  tooltip: 'Send',
                                  onPressed: _draft.text.trim().isEmpty ? null : _submit,
                                  icon: const Icon(Icons.arrow_upward),
                                ),
                              ],
                            ),
                            if (lastAssistant != null)
                              Align(
                                alignment: Alignment.centerRight,
                                child: TextButton(
                                  onPressed: () => store.regenerate(lastAssistant.id),
                                  child: const Text('Regenerate'),
                                ),
                              ),
                          ],
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
