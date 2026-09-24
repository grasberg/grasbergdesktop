import 'package:flutter/material.dart';

import '../main.dart';
import '../models/models.dart';
import '../state/app_store.dart';

/// The interactive cards: pending tool approvals and the assistant's
/// questions. They follow the user between views, exactly like the web
/// client's card deck.
class ApprovalCards extends StatelessWidget {
  const ApprovalCards({super.key, required this.store});

  final AppStore store;

  @override
  Widget build(BuildContext context) {
    if (store.approvals.isEmpty && store.questions.isEmpty) {
      return const SizedBox.shrink();
    }
    return Container(
      constraints: const BoxConstraints(maxHeight: 320),
      decoration: const BoxDecoration(
        color: Palette.surface,
        border: Border(bottom: BorderSide(color: Color(0xFF232930))),
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.all(12),
        children: [
          for (final request in store.approvals)
            _ApprovalCard(store: store, request: request),
          for (final request in store.questions)
            _QuestionCard(
              key: ValueKey(request.requestId),
              store: store,
              request: request,
            ),
        ],
      ),
    );
  }
}

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.store, required this.request});

  final AppStore store;
  final ToolApprovalRequest request;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Approval needed',
              style: TextStyle(
                fontWeight: FontWeight.w600,
                color: Palette.waiting,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '${request.toolName}${request.risk.isEmpty ? '' : ' (${request.risk})'}',
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 13,
                color: Palette.text,
              ),
            ),
            if (request.note != null && request.note!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  request.note!,
                  style: const TextStyle(color: Palette.muted, fontSize: 13),
                ),
              ),
            const SizedBox(height: 10),
            ExpansionTile(
              title: const Text('Review tool arguments'),
              children: [SelectableText(request.toolArguments)],
            ),
            if (!store.isConnected) const Text('Reconnect to respond.'),
            Row(
              children: [
                FilledButton(
                  onPressed:
                      !store.isConnected ||
                          store.responding.contains(request.requestId)
                      ? null
                      : () => store.respondApproval(request.requestId, true),
                  child: const Text('Allow once'),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed:
                      !store.isConnected ||
                          store.responding.contains(request.requestId)
                      ? null
                      : () => store.respondApproval(request.requestId, false),
                  child: const Text('Deny'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _QuestionCard extends StatefulWidget {
  const _QuestionCard({super.key, required this.store, required this.request});

  final AppStore store;
  final UserQuestionRequest request;

  @override
  State<_QuestionCard> createState() => _QuestionCardState();
}

class _QuestionCardState extends State<_QuestionCard> {
  final TextEditingController _custom = TextEditingController();

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    final request = widget.request;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'The assistant asks',
              style: TextStyle(
                fontWeight: FontWeight.w600,
                color: Palette.accent,
              ),
            ),
            const SizedBox(height: 4),
            Text(request.question, style: const TextStyle(color: Palette.text)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final option in request.options)
                  ActionChip(
                    label: Text(option),
                    onPressed:
                        !store.isConnected ||
                            store.responding.contains(request.requestId)
                        ? null
                        : () =>
                              store.respondQuestion(request.requestId, option),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _custom,
                    onChanged: (_) => setState(() {}),
                    decoration: const InputDecoration(
                      hintText: 'Custom answer…',
                    ),
                    style: const TextStyle(fontSize: 14),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed:
                      !store.isConnected ||
                          store.responding.contains(request.requestId) ||
                          _custom.text.trim().isEmpty
                      ? null
                      : () async {
                          final ok = await store.respondQuestion(
                            request.requestId,
                            _custom.text.trim(),
                          );
                          if (ok && mounted) _custom.clear();
                        },
                  child: const Text('Send'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
