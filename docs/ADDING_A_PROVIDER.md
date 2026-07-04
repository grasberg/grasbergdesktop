# Adding a provider

This walkthrough adds a fictional provider, **Acme AI**, to Grasberg
Desktop. Most providers speak the OpenAI chat-completions dialect, so the
typical adapter is a small subclass of the OpenAI-compatible base. The
contract every adapter must satisfy is `ProviderAdapter` in
[`src/main/providers/adapter.ts`](../src/main/providers/adapter.ts):

```ts
export interface ProviderAdapter {
  readonly type: ProviderType
  /** Live model listing; throw ProviderError('not_supported') when unavailable. */
  listModels(ctx: AdapterContext): Promise<ModelInfo[]>
  /** Streaming chat completion. */
  chatStream(req: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<AdapterStreamEvent>
  /** Non-streaming chat completion. */
  chat(req: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult>
  /** Cheap connectivity + auth check used by Settings "Test". */
  testConnection(ctx: AdapterContext): Promise<TestConnectionResult>
}
```

Rules for implementers (from the same file):

- **Never** log or embed the API key in errors. Use `redact()` from
  `src/main/providers/redact.ts`.
- Throw `ProviderError` (`src/main/providers/errors.ts`) for all failures so
  they normalize to `NormalizedError` codes
  (`auth | rate_limit | invalid_request | context_length | server | network | timeout | aborted | not_supported | unknown`).
- Respect `ctx.signal` for cancellation: abort the fetch and stop yielding.
- Validate response bodies with the zod schemas in `src/shared/schemas.ts`
  (`oaiChatCompletionSchema`, `oaiChatChunkSchema`, `oaiModelsListSchema`, …).

> **Heads-up:** built-in provider families are enumerated in the `ProviderType`
> union in `src/shared/types.ts` and in the `providers.type` CHECK constraint
> in the DB migrations — both are pinned contracts. If your provider is
> OpenAI-compatible, consider whether the existing `openai-compatible` custom
> type already covers it before adding a new first-class family. The steps
> below assume you are extending the contract as part of a coordinated change.

## 1. Add catalog metadata (`src/shared/catalog.ts`)

Add a `ProviderTypeMeta` entry with the models you want to surface in the
model selector. This is also the fallback when the provider has no `/models`
endpoint (`supportsModelListing: false`).

```ts
// in PROVIDER_TYPES (src/shared/catalog.ts)
acme: {
  type: 'acme',
  label: 'Acme AI',
  defaultBaseUrl: 'https://api.acme.ai/v1',
  docsUrl: 'https://docs.acme.ai/',
  supportsModelListing: true,
  defaultModelId: 'acme-chat-large',
  knownModels: [
    model('acme-chat-large', 'Acme Chat Large', 128000, caps({ tools: true })),
    model('acme-think', 'Acme Think', 64000, caps({ reasoning: true })),
  ],
},
```

(`caps()` and `model()` are helpers already defined in that file. Model lists
are a convenience, not a cage — users can always type a custom model id.)

## 2. Implement the adapter

### 2a. OpenAI-compatible dialect (the common case)

Subclass the base in `src/main/providers/openai-compatible.ts`. The base class
handles request shaping, SSE parsing, streaming and non-streaming completions,
tool-call assembly from deltas, zod validation, error normalization, and retry
with backoff — a typical subclass only pins its `type` and overrides quirks:

```ts
// src/main/providers/acme.ts
import type { ModelInfo } from '@shared/types'
import { PROVIDER_TYPES } from '@shared/catalog'
import type { AdapterContext } from './adapter'
import { OpenAICompatibleAdapter } from './openai-compatible'

export class AcmeAdapter extends OpenAICompatibleAdapter {
  override readonly type = 'acme' as const

  // Acme has no /models endpoint — fall back to the static catalog.
  override async listModels(_ctx: AdapterContext): Promise<ModelInfo[]> {
    return PROVIDER_TYPES.acme.knownModels
  }
}
```

Look at the existing subclasses for real examples of quirk handling:

- `deepseek.ts` — live `/models`, `reasoning_content` for R1.
- `zhipu.ts` / `minimax.ts` — no model listing (catalog fallback),
  provider-specific error shapes.

### 2b. Non-OpenAI dialects

If the provider's wire format is genuinely different, implement
`ProviderAdapter` from scratch: shape `AdapterChatRequest.messages` /
`params` / `tools` into the provider's request format, and translate its
responses into `AdapterStreamEvent`s
(`text | reasoning | tool_call | usage | finish`) for `chatStream` and an
`AdapterChatResult` for `chat`. Use `ctx.fetchImpl ?? fetch` for HTTP so tests
can inject a mock, pass `ctx.signal` through to fetch, and put the key from
`ctx.apiKey` in the auth header only — never anywhere it could be serialized.

## 3. Register it (`src/main/providers/registry.ts`)

Add your adapter to the registry so the chat service can resolve it by
provider type:

```ts
// src/main/providers/registry.ts
import { AcmeAdapter } from './acme'

// add a case alongside the existing entries in createAdapter():
function createAdapter(type: ProviderType): ProviderAdapter {
  switch (type) {
    // ...existing cases...
    case 'acme':
      return new AcmeAdapter()
  }
}
```

`getAdapter(type)` memoizes one stateless instance per type — no further
wiring is needed.

The Settings UI picks up the new type automatically from the catalog
(`providers.listTypes` serves `PROVIDER_TYPE_LIST`).

## 4. Checklist before opening a PR

- [ ] **Streaming** works end to end: text deltas arrive incrementally,
      `finish` carries the right reason, `ctx.signal` abort stops the stream
      cleanly (no events after abort).
- [ ] **Non-streaming** `chat()` returns text, tool calls, usage and
      `finishReason`.
- [ ] **`listModels`** either returns live models or falls back to the catalog
      / throws `ProviderError('not_supported')` — consistent with
      `supportsModelListing` in the catalog entry.
- [ ] **`testConnection`** does a cheap authenticated call and returns a safe
      human-readable message with latency; it must distinguish bad-key
      (`auth`) from network failures.
- [ ] **Error normalization** maps the provider's status codes and error
      bodies to the right `ProviderErrorCode`, including quirks. Example:
      MiniMax can return HTTP 200 with the real error in a `base_resp` body
      field (`{ base_resp: { status_code, status_msg } }`) — the MiniMax
      adapter inspects that and throws the appropriate `ProviderError` instead
      of treating the response as success. Check your provider's docs for
      similar traps.
- [ ] **Redaction**: no code path can put `ctx.apiKey` into a log line, an
      error message, or a persisted record. Run error text through `redact()`.
- [ ] **Unit tests** in `tests/unit/` with a mocked `fetch` via
      `ctx.fetchImpl`: happy-path streaming (SSE fixture), non-streaming,
      tool-call delta assembly, each error class, abort behavior, and a
      redaction test proving a leaked key never appears in thrown errors.
- [ ] `npm run typecheck` and `npm test` pass.
