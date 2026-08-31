import 'package:flutter/material.dart';
import 'package:markdown_widget/markdown_widget.dart';

import '../main.dart';
import '../models/models.dart';

/// One chat bubble. User messages render as plain right-aligned text;
/// assistant messages render as markdown, mirroring the web client.
class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.message, this.streamingText});

  final Message message;

  /// When the message is the live placeholder, its streaming partial text is
  /// shown instead of the (still empty) persisted content.
  final String? streamingText;

  @override
  Widget build(BuildContext context) {
    final mine = message.fromUser;
    final content = streamingText ?? message.content;
    final isStreaming = streamingText != null;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.86,
        ),
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 12),
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
        decoration: BoxDecoration(
          color: mine ? Palette.accent : Palette.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isStreaming ? Palette.accent : const Color(0xFF232930),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!mine && (message.reasoning?.isNotEmpty ?? false))
              _ReasoningTile(text: message.reasoning!),
            if (mine)
              Text(content, style: const TextStyle(color: Colors.white, fontSize: 15, height: 1.35))
            else if (content.isEmpty && isStreaming)
              const Text('…', style: TextStyle(color: Palette.muted))
            else
              MarkdownBlock(
                data: content,
                config: MarkdownConfig.darkConfig,
              ),
            for (final call in message.toolCalls)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '⚙ ${call.name} · ${call.status}',
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: Palette.muted,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ReasoningTile extends StatefulWidget {
  const _ReasoningTile({required this.text});

  final String text;

  @override
  State<_ReasoningTile> createState() => _ReasoningTileState();
}

class _ReasoningTileState extends State<_ReasoningTile> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: 8),
        initiallyExpanded: false,
        onExpansionChanged: (open) => setState(() => _open = open),
        title: Text(
          _open ? 'Hide thinking' : 'Thinking',
          style: const TextStyle(color: Palette.muted, fontSize: 12),
        ),
        children: [
          Container(
            width: double.infinity,
            alignment: Alignment.centerLeft,
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: Palette.deep,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              widget.text,
              style: const TextStyle(color: Palette.muted, fontSize: 12, height: 1.35),
            ),
          ),
        ],
      ),
    );
  }
}
