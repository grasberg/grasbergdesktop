/**
 * User-defined HTTP tools: validation + mapping between the stored
 * CustomToolRecord (src/main/db/repositories/custom-tools.ts) and the
 * LLM-facing ToolDefinition.
 *
 * Mapping rules (fixed):
 * - ToolDefinition id  = 'custom:<uuid>' (uuid is the DB primary key)
 * - risk               = 'sensitive' (they always hit the network)
 * - builtin            = false
 */

import type { CustomToolInput, CustomToolPatch, ToolDefinition } from '@shared/types'
import type {
  CustomToolCreateInput,
  CustomToolRecord,
  CustomToolUpdateInput,
} from '../db/repositories/custom-tools'

export const CUSTOM_TOOL_ID_PREFIX = 'custom:'

export const CUSTOM_TOOL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type CustomToolMethod = (typeof CUSTOM_TOOL_METHODS)[number]

/** Function names must be valid OpenAI tool names. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// -- field validators (throw user-presentable Errors) -------------------------

function validateName(raw: string): string {
  const name = (raw ?? '').trim()
  if (!NAME_PATTERN.test(name)) {
    throw new Error('Tool name must be 1-64 characters using only letters, digits, "_" and "-".')
  }
  return name
}

function validateBaseUrl(raw: string): string {
  const baseUrl = (raw ?? '').trim()
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('Base URL must be a valid absolute URL.')
  }
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new Error('Base URL must use https:// (plain http is only allowed for localhost).')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL must not embed credentials; use headers instead.')
  }
  return baseUrl
}

function validateMethod(raw: string | undefined): string {
  const method = (raw ?? 'GET').trim().toUpperCase()
  if (!(CUSTOM_TOOL_METHODS as readonly string[]).includes(method)) {
    throw new Error(`Method must be one of: ${CUSTOM_TOOL_METHODS.join(', ')}.`)
  }
  return method
}

function validateHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out = headers ?? {}
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string' || key.trim().length === 0) {
      throw new Error('Headers must map non-empty names to string values.')
    }
  }
  return out
}

function validateParamsSchema(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  const paramsSchema = schema ?? { type: 'object', properties: {} }
  if (typeof paramsSchema !== 'object' || paramsSchema === null || Array.isArray(paramsSchema)) {
    throw new Error('paramsSchema must be a JSON Schema object.')
  }
  return paramsSchema
}

export function isCustomToolId(toolId: string): boolean {
  return toolId.startsWith(CUSTOM_TOOL_ID_PREFIX)
}

/** 'custom:<uuid>' -> '<uuid>' (already-bare ids pass through). */
export function customToolDbId(toolId: string): string {
  return isCustomToolId(toolId) ? toolId.slice(CUSTOM_TOOL_ID_PREFIX.length) : toolId
}

export function customToolDefinitionId(dbId: string): string {
  return `${CUSTOM_TOOL_ID_PREFIX}${dbId}`
}

/**
 * Validates user input and normalizes it into the repository shape.
 * Only the NON-secret `headers` land here; secret headers are stored
 * separately (encrypted) by the IPC layer via the secrets repository.
 * Throws Error with a user-presentable message on invalid input (callers at
 * the IPC boundary convert thrown errors into IpcResult errors).
 */
export function toCustomToolCreateInput(input: CustomToolInput): CustomToolCreateInput {
  return {
    name: validateName(input.name),
    description: (input.description ?? '').trim(),
    baseUrl: validateBaseUrl(input.baseUrl),
    method: validateMethod(input.method),
    headersJson: JSON.stringify(validateHeaders(input.headers)),
    paramsSchemaJson: JSON.stringify(validateParamsSchema(input.paramsSchema)),
  }
}

/** Validates a partial edit into the repository update shape (secret headers excluded). */
export function toCustomToolUpdateInput(patch: CustomToolPatch): CustomToolUpdateInput {
  const out: CustomToolUpdateInput = {}
  if (patch.name !== undefined) out.name = validateName(patch.name)
  if (patch.description !== undefined) out.description = patch.description.trim()
  if (patch.baseUrl !== undefined) out.baseUrl = validateBaseUrl(patch.baseUrl)
  if (patch.method !== undefined) out.method = validateMethod(patch.method)
  if (patch.headers !== undefined) out.headersJson = JSON.stringify(validateHeaders(patch.headers))
  if (patch.paramsSchema !== undefined) {
    out.paramsSchemaJson = JSON.stringify(validateParamsSchema(patch.paramsSchema))
  }
  return out
}

/** Stored record -> LLM-facing definition (enabled flag applied by the registry). */
export function customToolToDefinition(record: CustomToolRecord, enabled: boolean): ToolDefinition {
  let parameters: Record<string, unknown> = { type: 'object', properties: {} }
  try {
    const parsed: unknown = JSON.parse(record.paramsSchemaJson)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      parameters = parsed as Record<string, unknown>
    }
  } catch {
    // corrupt schema — fall back to "no arguments"
  }
  return {
    id: customToolDefinitionId(record.id),
    name: record.name,
    description:
      record.description.length > 0
        ? record.description
        : `Custom HTTP tool calling ${record.method} ${record.baseUrl}.`,
    parameters,
    risk: 'sensitive',
    builtin: false,
    enabled,
    source: 'custom',
  }
}

/** Parsed headers of a stored record ({} on corrupt JSON). */
export function customToolHeaders(record: CustomToolRecord): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(record.headersJson)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value
      }
      return out
    }
  } catch {
    // fall through
  }
  return {}
}
