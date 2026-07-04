/**
 * Pure transform from the models.dev catalog (`https://models.dev/api.json`)
 * into Grasberg's OpenAI-compatible **preset** catalog. No IO — the generator
 * script (`scripts/generate-presets.ts`) does the download/write; this file is
 * the single, unit-tested source of the mapping so regeneration is
 * deterministic. The runtime facade (`presets.ts`) decodes the generated data.
 *
 * A preset is data, not code: every preset maps onto the existing
 * `openai-compatible` adapter (base URL + curated model list + key), so adding
 * ~138 providers needs no new ProviderType and no DB migration.
 */

import type { ModelCapabilities, ModelInfo } from './types'
import type { ModelPricing } from './pricing'

// --- models.dev input shape (only the fields we consume) -------------------

export interface ModelsDevModel {
  id: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  release_date?: string
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number }
}
export interface ModelsDevProvider {
  id: string
  name?: string
  npm?: string
  doc?: string
  api?: string
  env?: string[]
  models?: Record<string, ModelsDevModel>
}
export type ModelsDevApi = Record<string, ModelsDevProvider>

// --- output shape ----------------------------------------------------------

export interface PresetMeta {
  id: string
  name: string
  baseUrl: string
  docsUrl?: string
  /** Label for the API-key field, e.g. "API key (GROQ_API_KEY)". */
  keyLabel?: string
  defaultModelId: string
}

/** [id, label, ctx, maxOut, tools, vision, reasoning, in$, out$, cache$]. */
export type PresetModelTuple = [string, string, number, number, 0 | 1, 0 | 1, 0 | 1, number, number, number]

export interface GeneratedPresets {
  meta: PresetMeta[]
  /** presetId → tuple-encoded models. */
  models: Record<string, PresetModelTuple[]>
}

// --- selection rules -------------------------------------------------------

/** Native-dialect SDKs (different wire format) — handled by dedicated adapters. */
const EXCLUDE_NPM = new Set([
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/google-vertex',
  '@ai-sdk/google-vertex/anthropic',
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/cohere',
  '@ai-sdk/azure', // needs a deployment name + api-version query, not base+model
])

/** Providers already shipped as first-class families, or otherwise unsupported. */
const EXCLUDE_IDS = new Set([
  'openai',
  'deepseek',
  'minimax',
  'zhipuai',
  'zai',
  'azure',
  'azure-cognitive-services',
])

/** Base URLs for OpenAI-compatible providers that omit `api` (SDK defaults). */
const SDK_DEFAULT_BASEURL: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  togetherai: 'https://api.together.xyz/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  perplexity: 'https://api.perplexity.ai',
  cerebras: 'https://api.cerebras.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  venice: 'https://api.venice.ai/api/v1',
  aihubmix: 'https://aihubmix.com/v1',
}

const bit = (b: boolean | undefined): 0 | 1 => (b ? 1 : 0)
/** Cost is `-1` when models.dev has no cost block (unknown ≠ free). */
const priceOr = (v: number | undefined, hasCost: boolean): number =>
  hasCost ? (typeof v === 'number' ? v : 0) : -1

function encodeModel(m: ModelsDevModel): PresetModelTuple {
  const hasCost = m.cost !== undefined
  return [
    m.id,
    m.name ?? m.id,
    m.limit?.context ?? 0,
    m.limit?.output ?? 0,
    bit(m.tool_call),
    bit(m.attachment),
    bit(m.reasoning),
    priceOr(m.cost?.input, hasCost),
    priceOr(m.cost?.output, hasCost),
    priceOr(m.cost?.cache_read, hasCost),
  ]
}

/** Newest by release_date, tie-broken by id ascending (deterministic). */
function pickDefaultModel(models: ModelsDevModel[]): string {
  const sorted = [...models].sort((a, b) => {
    const byDate = (b.release_date ?? '').localeCompare(a.release_date ?? '')
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id)
  })
  return sorted[0]?.id ?? ''
}

export interface BuildResult extends GeneratedPresets {
  /** Provider ids skipped for lack of a usable base URL (for the generator log). */
  skipped: string[]
}

/**
 * Build the preset catalog. Deterministic: providers sorted by id, models by id.
 * Excludes native-dialect SDKs, azure, and first-class families; skips providers
 * with no resolvable base URL.
 */
export function buildPresetCatalog(api: ModelsDevApi): BuildResult {
  const meta: PresetMeta[] = []
  const models: Record<string, PresetModelTuple[]> = {}
  const skipped: string[] = []

  for (const id of Object.keys(api).sort()) {
    const p = api[id]
    if (EXCLUDE_IDS.has(id) || (p.npm && EXCLUDE_NPM.has(p.npm))) continue
    const modelList = Object.values(p.models ?? {})
    if (modelList.length === 0) continue
    const baseUrl = p.api ?? SDK_DEFAULT_BASEURL[id]
    if (!baseUrl) {
      skipped.push(id)
      continue
    }
    const sortedModels = [...modelList].sort((a, b) => a.id.localeCompare(b.id))
    models[id] = sortedModels.map(encodeModel)
    meta.push({
      id,
      name: p.name ?? id,
      baseUrl,
      docsUrl: p.doc,
      keyLabel: p.env && p.env[0] ? `API key (${p.env[0]})` : 'API key',
      defaultModelId: pickDefaultModel(modelList),
    })
  }

  return { meta, models, skipped }
}

// --- decoders (used by the runtime facade) ---------------------------------

const caps = (t: PresetModelTuple): ModelCapabilities => ({
  streaming: true,
  tools: t[4] === 1,
  vision: t[5] === 1,
  reasoning: t[6] === 1,
})

export function decodeModel(t: PresetModelTuple): ModelInfo {
  return {
    id: t[0],
    label: t[1] || t[0],
    contextLength: t[2] || undefined,
    maxOutputTokens: t[3] || undefined,
    capabilities: caps(t),
    fromCatalog: true,
  }
}

export function decodePricing(t: PresetModelTuple): ModelPricing | undefined {
  const input = t[7]
  const output = t[8]
  if (input < 0 && output < 0) return undefined // unknown (no cost block)
  return {
    inputPerMTok: Math.max(0, input),
    outputPerMTok: Math.max(0, output),
    ...(t[9] >= 0 ? { cachedInputPerMTok: t[9] } : {}),
  }
}
