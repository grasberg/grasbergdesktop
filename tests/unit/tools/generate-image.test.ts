/**
 * generate_image through the REAL registry + executor: registry visibility
 * (hidden without an image-capable target), the approval flow as the cost
 * gate, argument validation, onAttachment delivery, and the unavailable path.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, Conversation, ToolCallRecord } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { createToolSystem, USER_DECLINED_RESULT } from '../../../src/main/tools'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-genimage-'))
  db = openDatabase(join(dir, 'app.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const conversation: Conversation = {
  id: 'conv-img',
  mode: 'chat',
  title: 'Img',
  providerId: null,
  modelId: null,
  systemPrompt: null,
  params: {},
  workspaceId: null,
  projectId: null,
  projectRef: null,
  moaPresetId: null,
  createdAt: 0,
  updatedAt: 0,
}

function call(args: unknown): ToolCallRecord {
  return {
    id: 'tc-img',
    name: 'generate_image',
    arguments: JSON.stringify(args),
    status: 'proposed',
  }
}

function fakeAttachment(): Attachment {
  return {
    id: randomUUID(),
    name: 'a-fox.png',
    mimeType: 'image/png',
    sizeBytes: 42,
    kind: 'image',
    storageKey: `${randomUUID()}.png`,
    generatedBy: { modelId: 'img-model', size: 'square' },
  }
}

const APPROVE = { approved: true, scope: 'once' as const }
const DECLINE = { approved: false, scope: 'once' as const }

describe('registry visibility', () => {
  it('hides generate_image without any image-capable target and shows it with one', () => {
    const { registry } = createToolSystem(db)
    expect(registry.listDefinitions().some((d) => d.id === 'generate_image')).toBe(false)

    // An explicit settings default is enough…
    db.settings.update({ defaultImageProviderId: 'some-provider' })
    expect(registry.listDefinitions().some((d) => d.id === 'generate_image')).toBe(true)

    // …and so is an enabled, keyed provider of an image-capable family.
    db.settings.update({ defaultImageProviderId: null })
    expect(registry.listDefinitions().some((d) => d.id === 'generate_image')).toBe(false)
    const provider = db.providers.create({
      id: randomUUID(),
      type: 'zhipu',
      label: 'GLM',
      baseUrl: 'https://open.bigmodel.example/v4',
      defaultModelId: 'glm-4.6',
      enabled: true,
    })
    db.providers.setKeyRow(provider.id, 'insecure:' + Buffer.from('k').toString('base64'), 'k…')
    expect(registry.listDefinitions().some((d) => d.id === 'generate_image')).toBe(true)
  })
})

describe('generate_image execution', () => {
  function makeSystem(generate: (req: unknown) => Promise<Attachment[]>) {
    db.settings.update({ defaultImageProviderId: 'p1' }) // make the tool visible
    return createToolSystem(db, null, { imageGeneration: { generate } })
  }

  it("risk 'sensitive' => approval is requested; approve runs and delivers attachments", async () => {
    const stored = fakeAttachment()
    const generate = vi.fn(async () => [stored])
    const { executor } = makeSystem(generate)
    const approval = vi.fn(async () => APPROVE)
    const received: Attachment[] = []

    const result = await executor.execute(call({ prompt: 'a red fox', size: 'square' }), {
      conversation,
      approval,
      onAttachment: (a) => received.push(a),
    })

    expect(approval).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith({ prompt: 'a red fox', count: 1, size: 'square' })
    expect(received).toEqual([stored])
    expect(result).toContain('Generated 1 image')
    expect(result).toContain('img-model')
  })

  it('decline returns the standard note without generating', async () => {
    const generate = vi.fn(async () => [fakeAttachment()])
    const { executor } = makeSystem(generate)
    const result = await executor.execute(call({ prompt: 'x' }), {
      conversation,
      approval: vi.fn(async () => DECLINE),
      onAttachment: () => undefined,
    })
    expect(result).toBe(USER_DECLINED_RESULT)
    expect(generate).not.toHaveBeenCalled()
  })

  it('validates the prompt and clamps count', async () => {
    const generate = vi.fn(async () => [fakeAttachment()])
    const { executor } = makeSystem(generate)
    const missing = await executor.execute(call({}), {
      conversation,
      approval: vi.fn(async () => APPROVE),
      onAttachment: () => undefined,
    })
    expect(missing).toContain('missing required argument')

    await executor.execute(call({ prompt: 'x', count: 99, size: 'bogus' }), {
      conversation,
      approval: vi.fn(async () => APPROVE),
      onAttachment: () => undefined,
    })
    expect(generate).toHaveBeenCalledWith({ prompt: 'x', count: 4, size: 'auto' })
  })

  it('reports unavailable without the dep or the onAttachment sink', async () => {
    db.settings.update({ defaultImageProviderId: 'p1' })
    const { executor } = createToolSystem(db) // no imageGeneration dep
    const noDep = await executor.execute(call({ prompt: 'x' }), {
      conversation,
      approval: vi.fn(async () => APPROVE),
      onAttachment: () => undefined,
    })
    expect(noDep).toContain('unavailable')

    const { executor: withDep } = makeSystem(async () => [fakeAttachment()])
    const noSink = await withDep.execute(call({ prompt: 'x' }), {
      conversation,
      approval: vi.fn(async () => APPROVE),
      // no onAttachment: delegate/workflow loops
    })
    expect(noSink).toContain('unavailable')
  })

  it('turns a generation failure into a readable result string', async () => {
    const { executor } = makeSystem(async () => {
      throw new Error('quota exceeded')
    })
    const result = await executor.execute(call({ prompt: 'x' }), {
      conversation,
      approval: vi.fn(async () => APPROVE),
      onAttachment: () => undefined,
    })
    expect(result).toContain('Image generation failed')
    expect(result).toContain('quota exceeded')
  })
})
