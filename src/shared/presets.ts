/**
 * Runtime facade over the generated preset catalog. Decodes the tuple-encoded
 * model blob lazily (once) and memoizes per preset. Consumed by the catalog
 * resolvers (main + renderer), the IPC create/listModels handlers, and the
 * renderer's cost estimate.
 */

import { PRESET_META, PRESET_MODELS_JSON } from './presets.generated'
import { decodeModel, decodePricing, type PresetMeta, type PresetModelTuple } from './presets.build'
import type { ModelInfo } from './types'
import type { ModelPricing } from './pricing'

const metaById = new Map<string, PresetMeta>(PRESET_META.map((m) => [m.id, m]))

let rawModelsCache: Record<string, PresetModelTuple[]> | null = null
function rawModels(): Record<string, PresetModelTuple[]> {
  if (!rawModelsCache) rawModelsCache = JSON.parse(PRESET_MODELS_JSON) as Record<string, PresetModelTuple[]>
  return rawModelsCache
}

const decodedModels = new Map<string, ModelInfo[]>()

/** All presets, for the add-provider picker (small; id/name/baseUrl/default). */
export function presetMetaList(): PresetMeta[] {
  return PRESET_META
}

export function presetMeta(id: string): PresetMeta | undefined {
  return metaById.get(id)
}

export function isKnownPreset(id: string): boolean {
  return metaById.has(id)
}

/** Decoded model catalog for a preset (memoized). */
export function presetModels(id: string): ModelInfo[] {
  let cached = decodedModels.get(id)
  if (!cached) {
    cached = (rawModels()[id] ?? []).map(decodeModel)
    decodedModels.set(id, cached)
  }
  return cached
}

/** Approximate pricing for one model of a preset, or undefined when unknown. */
export function presetPricing(id: string, modelId: string): ModelPricing | undefined {
  const tuples = rawModels()[id]
  if (!tuples) return undefined
  const t = tuples.find((x) => x[0] === modelId)
  return t ? decodePricing(t) : undefined
}
