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
  bool _followBottom = true;

  AppStore get store => widget.store;

  @override
  void initState() {
    super.initState();
    // The send button's enabled state tracks the draft.
    _draft.text = store.drafts[store.currentId] ?? '';
    _draft.addListener(() {
      final id = store.currentId;
      if (id != null) store.setDraft(id, _draft.text);
      setState(() {});
    });
    _scroll.addListener(() {
      final follow = _scroll.position.maxScrollExtent - _scroll.offset < 100;
      if (follow != _followBottom) setState(() => _followBottom = follow);
    });
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
      if (_followBottom) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      }
    }
  }

  void _submit() async {
    final text = _draft.text.trim();
    final id = store.currentId;
    if (text.isEmpty || !store.isConnected || store.sends[id]?.sending == true) {
      return;
    }
    final sent = await store.sendMessage(text);
    if (mounted && sent && id == store.currentId && _draft.text.trim() == text) {
      _draft.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final currentId = store.currentId ?? '';
        final activeStreams = [
          ...store.streams.entries.where(
            (e) => e.value.conversationId == currentId,
          ),
        ];
        final streaming = activeStreams.isNotEmpty;
        // The placeholder assistant message of a live stream would render as
        // an empty bubble; show only the live partial instead.
        final visibleMessages = store.messages
            .where((m) => !streaming || m.status != 'streaming')
            .toList();
        final lastAssistant = visibleMessages
            .where((m) => m.role == 'assistant')
            .fold<Message?>(null, (acc, m) => m);
        final renderLength =
            visibleMessages.length +
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
                if (!_followBottom)
                  TextButton(
                    onPressed: () {
                      _followBottom = true;
                      _scrollToBottom();
                    },
                    child: const Text('Jump to latest ↓'),
                  ),
                if (!store.isConnected)
                  const Text('Offline — your draft is saved on this device.'),
                if (store.sends[currentId]?.error != null)
                  Padding(
                    padding: const EdgeInsets.all(8),
                    child: Text(
                      store.sends[currentId]!.error!,
                      style: const TextStyle(color: Palette.errorColor),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                  child: Column(
                    children: [
                      if (streaming)
                        SizedBox(
                          width: double.infinity,
                          child: OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: Palette.errorColor,
                            ),
                            onPressed: store.isConnected
                                ? () =>
                                      store.stopStream(activeStreams.first.key)
                                : null,
                            icon: const Icon(Icons.stop),
                            label: const Text('Stop generating'),
                          ),
                        ),
                      Column(
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
                                onPressed:
                                    !store.isConnected ||
                                        store.sends[currentId]?.sending ==
                                            true ||
                                        _draft.text.trim().isEmpty
                                    ? null
                                    : _submit,
                                icon: store.sends[currentId]?.sending == true
                                    ? const SizedBox(
                                        width: 20,
                                        height: 20,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : const Icon(Icons.arrow_upward),
                              ),
                            ],
                          ),
                          if (lastAssistant != null && !streaming)
                            Align(
                              alignment: Alignment.centerRight,
                              child: TextButton(
                                onPressed: store.isConnected
                                    ? () => store.regenerate(lastAssistant.id)
                                    : null,
                                child: const Text('Regenerate'),
                              ),
                            ),
                        ],
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
