/// Typed views of the desktop's JSON payloads — the Dart mirror of the shapes
/// in src/shared/types.ts that the phone surface consumes. Parsing is lenient
/// by design: unknown fields are ignored, so desktop releases may add fields
/// without breaking the phone.
library;

// ---------------------------------------------------------------------------
// IpcResult<T>
// ---------------------------------------------------------------------------

class IpcError {
  IpcError({required this.code, required this.message, required this.retryable});

  factory IpcError.fromJson(Object? raw) {
    if (raw is Map) {
      return IpcError(
        code: raw['code'] is String ? raw['code'] as String : 'unknown',
        message: raw['message'] is String ? raw['message'] as String : 'Unknown error.',
        retryable: raw['retryable'] == true,
      );
    }
    return IpcError(code: 'unknown', message: 'Unknown error.', retryable: false);
  }

  final String code;
  final String message;
  final bool retryable;
}

/// The renderer's IpcResult contract, verbatim: either `{ok:true, data}` or
/// `{ok:false, error:{code,message,retryable}}`.
class IpcResult<T> {
  IpcResult.ok(this.data) : error = null;
  IpcResult.err(this.error) : data = null;

  final T? data;
  final IpcError? error;

  bool get ok => error == null;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

class ConversationSummary {
  ConversationSummary({
    required this.id,
    required this.mode,
    required this.title,
    required this.updatedAt,
    required this.snippet,
    this.projectRef,
  });

  factory ConversationSummary.fromJson(Object? raw) {
    final m = _map(raw);
    return ConversationSummary(
      id: _str(m, 'id'),
      mode: _str(m, 'mode', fallback: 'chat'),
      title: _str(m, 'title'),
      updatedAt: _int(m, 'updatedAt'),
      snippet: m['snippet'] is String ? m['snippet'] as String : null,
      projectRef: m['projectRef'] is String ? m['projectRef'] as String : null,
    );
  }

  final String id;
  final String mode;
  final String title;
  final int updatedAt;
  final String? snippet;
  final String? projectRef;
}

class Conversation {
  Conversation({
    required this.id,
    required this.mode,
    required this.title,
    required this.providerId,
    required this.modelId,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Conversation.fromJson(Object? raw) {
    final m = _map(raw);
    return Conversation(
      id: _str(m, 'id'),
      mode: _str(m, 'mode', fallback: 'chat'),
      title: _str(m, 'title'),
      providerId: m['providerId'] is String ? m['providerId'] as String : null,
      modelId: m['modelId'] is String ? m['modelId'] as String : null,
      createdAt: _int(m, 'createdAt'),
      updatedAt: _int(m, 'updatedAt'),
    );
  }

  final String id;
  final String mode;
  final String title;
  final String? providerId;
  final String? modelId;
  final int createdAt;
  final int updatedAt;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

class ToolCallRecord {
  ToolCallRecord({
    required this.id,
    required this.name,
    required this.arguments,
    required this.status,
    this.result,
  });

  factory ToolCallRecord.fromJson(Object? raw) {
    final m = _map(raw);
    return ToolCallRecord(
      id: _str(m, 'id'),
      name: _str(m, 'name'),
      arguments: _str(m, 'arguments'),
      status: _str(m, 'status', fallback: 'done'),
      result: m['result'] is String ? m['result'] as String : null,
    );
  }

  final String id;
  final String name;
  final String arguments;
  final String status;
  final String? result;
}

class Message {
  Message({
    required this.id,
    required this.conversationId,
    required this.role,
    required this.content,
    required this.status,
    required this.seq,
    required this.createdAt,
    this.reasoning,
    this.toolCalls = const [],
    this.modelId,
  });

  factory Message.fromJson(Object? raw) {
    final m = _map(raw);
    return Message(
      id: _str(m, 'id'),
      conversationId: _str(m, 'conversationId'),
      role: _str(m, 'role', fallback: 'assistant'),
      content: _str(m, 'content'),
      status: _str(m, 'status', fallback: 'complete'),
      seq: _int(m, 'seq'),
      createdAt: _int(m, 'createdAt'),
      reasoning: m['reasoning'] is String ? m['reasoning'] as String : null,
      toolCalls: (m['toolCalls'] as List?)
              ?.map(ToolCallRecord.fromJson)
              .toList() ??
          const [],
      modelId: m['modelId'] is String ? m['modelId'] as String : null,
    );
  }

  final String id;
  final String conversationId;
  final String role;
  final String content;
  final String status;
  final String? reasoning;
  final List<ToolCallRecord> toolCalls;
  final String? modelId;
  final int seq;
  final int createdAt;

  bool get fromUser => role == 'user';
}

/// Result of chat:send / chat:regenerate — the stream to listen on plus the
/// already-persisted user + placeholder assistant messages.
class StartStreamResult {
  StartStreamResult({
    required this.streamId,
    required this.userMessage,
    required this.assistantMessage,
  });

  factory StartStreamResult.fromJson(Object? raw) {
    final m = _map(raw);
    return StartStreamResult(
      streamId: _str(m, 'streamId'),
      userMessage: m['userMessage'] == null ? null : Message.fromJson(m['userMessage']),
      assistantMessage: Message.fromJson(m['assistantMessage']),
    );
  }

  final String streamId;
  final Message? userMessage;
  final Message assistantMessage;
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

class TokenUsage {
  factory TokenUsage.fromJson(Object? raw) {
    final m = _map(raw);
    return TokenUsage(
      promptTokens: m['promptTokens'] is int ? m['promptTokens'] as int : null,
      completionTokens: m['completionTokens'] is int ? m['completionTokens'] as int : null,
      totalTokens: m['totalTokens'] is int ? m['totalTokens'] as int : null,
    );
  }

  TokenUsage({this.promptTokens, this.completionTokens, this.totalTokens});

  final int? promptTokens;
  final int? completionTokens;
  final int? totalTokens;
}

/// One envelope from the `push:streamEvent` channel.
class StreamEventEnvelope {
  factory StreamEventEnvelope.fromJson(Object? raw) {
    final m = _map(raw);
    final event = _map(m['event']);
    final type = event['type'] is String ? event['type'] as String : '';
    return StreamEventEnvelope(
      streamId: _str(m, 'streamId'),
      conversationId: _str(m, 'conversationId'),
      type: type,
      text: event['text'] is String ? event['text'] as String : null,
      toolCallId: event['toolCallId'] is String ? event['toolCallId'] as String : null,
      chunk: event['chunk'] is String ? event['chunk'] as String : null,
      usage: event['usage'] == null ? null : TokenUsage.fromJson(event['usage']),
      finishReason: event['finishReason'] is String ? event['finishReason'] as String : null,
      message: event['message'] == null ? null : Message.fromJson(event['message']),
      errorMessage:
          _map(event['error'])['message'] is String ? _map(event['error'])['message'] as String : null,
    );
  }

  StreamEventEnvelope({
    required this.streamId,
    required this.conversationId,
    required this.type,
    this.text,
    this.toolCallId,
    this.chunk,
    this.usage,
    this.finishReason,
    this.message,
    this.errorMessage,
  });

  final String streamId;
  final String conversationId;
  final String type;
  final String? text;
  final String? toolCallId;
  final String? chunk;
  final TokenUsage? usage;
  final String? finishReason;
  final Message? message;
  final String? errorMessage;

  bool get isDelta => type == 'text-delta' || type == 'reasoning-delta';
  bool get isTerminal => type == 'done' || type == 'error';
}

// ---------------------------------------------------------------------------
// Interactive cards
// ---------------------------------------------------------------------------

class ToolApprovalRequest {
  factory ToolApprovalRequest.fromJson(Object? raw) {
    final m = _map(raw);
    return ToolApprovalRequest(
      requestId: _str(m, 'requestId'),
      streamId: _str(m, 'streamId'),
      conversationId: _str(m, 'conversationId'),
      toolName: _map(m['toolCall'])['name'] is String ? _map(m['toolCall'])['name'] as String : '?',
      toolArguments: _map(m['toolCall'])['arguments'] is String
          ? _map(m['toolCall'])['arguments'] as String
          : '',
      risk: m['risk'] is String ? m['risk'] as String : '',
      note: m['note'] is String ? m['note'] as String : null,
    );
  }

  ToolApprovalRequest({
    required this.requestId,
    required this.streamId,
    required this.conversationId,
    required this.toolName,
    required this.toolArguments,
    required this.risk,
    this.note,
  });

  final String requestId;
  final String streamId;
  final String conversationId;
  final String toolName;
  final String toolArguments;
  final String risk;
  final String? note;
}

class UserQuestionRequest {
  factory UserQuestionRequest.fromJson(Object? raw) {
    final m = _map(raw);
    return UserQuestionRequest(
      requestId: _str(m, 'requestId'),
      streamId: _str(m, 'streamId'),
      conversationId: _str(m, 'conversationId'),
      question: _str(m, 'question'),
      options: (m['options'] as List?)?.whereType<String>().toList() ?? const [],
    );
  }

  UserQuestionRequest({
    required this.requestId,
    required this.streamId,
    required this.conversationId,
    required this.question,
    required this.options,
  });

  final String requestId;
  final String streamId;
  final String conversationId;
  final String question;
  final List<String> options;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

Map<String, dynamic> _map(Object? raw) => raw is Map ? Map<String, dynamic>.from(raw) : {};

String _str(Map<String, dynamic> m, String key, {String fallback = ''}) =>
    m[key] is String ? m[key] as String : fallback;

int _int(Map<String, dynamic> m, String key) => m[key] is int ? m[key] as int : 0;
