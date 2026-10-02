/**
 * Personal-agent layer (v53), part B–D: the dots rule behaviours (act / act
 * if requested / ask / hand off / block), Sentinel-style read-only MCP
 * connectors, steps handed to the user (rules, hand_off, password and payment
 * fields), the credential vault, and the auto-reviewer for outward calls.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ToolApprovalAnswer, ToolCallRecord, ToolRule } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { createToolSystem, USER_DECLINED_RESULT } from '../../src/main/tools'
import { matchToolRules } from '../../src/main/tools/tool-rules'
import { McpManager } from '../../src/main/tools/mcp/manager'
import type { McpConnector } from '../../src/main/tools/mcp/transports'
import { LoginVault } from '../../src/main/services/login-vault'
import { runInNewContext } from 'node:vm'
import { SENSITIVE_FIELD_SENTINEL, buildSnapshotJs, originOf } from '../../src/main/browser/sensitive'
import {
  CHANNEL_EVENT_POLICY,
  mergeInvocationPolicies,
  withInvocationPolicy,
} from '../../src/main/invocation-context'
import { BUILTIN_TOOL_DEFINITIONS } from '../../src/main/tools/definitions'
import {
  AutoReviewer,
  buildReviewPrompt,
  parseReviewVerdict,
} from '../../src/main/services/auto-review'
import { BotService, type BotChatService } from '../../src/main/services/bots'

let dir: string
let db: AppDatabase

const keystore = {
  encryptKey: (v: string) => ({ encryptedBase64: `x:${Buffer.from(v).toString('base64')}`, preview: '…' }),
  decryptKey: (s: string) => Buffer.from(s.slice(2), 'base64').toString('utf8'),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-pa-perms-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1',
  mode: 'chat',
  title: 'Chat',
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
  ...overrides,
})

const call = (name: string, args: unknown): ToolCallRecord => ({
  id: 'tc',
  name,
  arguments: JSON.stringify(args),
  status: 'proposed',
})

const APPROVE: ToolApprovalAnswer = { approved: true, scope: 'once' }
const DECLINE: ToolApprovalAnswer = { approved: false, scope: 'once' }

const rule = (effect: ToolRule['effect'], pattern: string | null = null): ToolRule => ({
  id: effect,
  toolId: 'fetch_url',
  effect,
  scope: 'global',
  scopeId: null,
  pattern,
  createdAt: 0,
})

describe('rule effects (dots behaviours)', () => {
  it('the strongest matching rule wins', () => {
    const ctx = { toolId: 'fetch_url', conversationId: 'c', args: { url: 'https://a.example.com' } }
    expect(matchToolRules([rule('allow'), rule('allow_if_requested')], ctx)).toBe(
      'allow_if_requested'
    )
    expect(matchToolRules([rule('allow'), rule('require_approval')], ctx)).toBe('require_approval')
    expect(matchToolRules([rule('require_approval'), rule('handoff')], ctx)).toBe('handoff')
    expect(matchToolRules([rule('handoff'), rule('block'), rule('allow')], ctx)).toBe('block')
    expect(matchToolRules([], ctx)).toBeNull()
  })

  it('an un-evaluable pattern makes stop rules match and go rules miss', () => {
    const ctx = { toolId: 'fetch_url', conversationId: 'c', args: { url: 'not a url' } }
    expect(matchToolRules([rule('block', 'example.com')], ctx)).toBe('block')
    expect(matchToolRules([rule('handoff', 'example.com')], ctx)).toBe('handoff')
    expect(matchToolRules([rule('allow_if_requested', 'example.com')], ctx)).toBeNull()
  })

  it("'block' refuses without asking, 'handoff' records a your-turn item", async () => {
    const handoffs: Array<{ title: string }> = []
    const { executor } = createToolSystem(db, null, {
      handoff: (_ctx, item) => handoffs.push(item),
    })
    const approval = vi.fn(async () => APPROVE)
    db.toolRules.create({ toolId: 'web_search', effect: 'block', scope: 'global' })
    const blocked = await executor.execute(call('web_search', { query: 'x' }), {
      conversation: conversation(),
      approval,
    })
    expect(blocked).toMatch(/blocks 'web_search'/)
    expect(approval).not.toHaveBeenCalled()
    expect(db.activity.list({ limit: 5 }).entries[0].decision).toBe('blocked')

    db.toolRules.create({ toolId: 'propose_shell_command', effect: 'handoff', scope: 'global' })
    const handed = await executor.execute(call('propose_shell_command', { command: 'ls' }), {
      conversation: conversation(),
      approval,
    })
    expect(handed).toMatch(/handed to them/)
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0].title).toContain('propose_shell_command')
    expect(db.activity.list({ limit: 5 }).entries[0].decision).toBe('handoff')
  })

  it("'allow_if_requested' runs in user turns and asks in proactive / event / agent turns", async () => {
    db.toolRules.create({ toolId: 'fetch_url', effect: 'allow_if_requested', scope: 'global' })
    let origin: 'event' | 'proactive' | 'agent' | null = null
    const { executor } = createToolSystem(db, null, {
      turnOrigin: () => origin,
      fetchImpl: (async () =>
        new Response('hello', { headers: { 'content-type': 'text/plain' } })) as typeof fetch,
    })
    const approval = vi.fn(async () => DECLINE)
    // A user turn: the rule waves it through (the network part may fail in
    // the sandbox — what matters is that nobody was asked).
    await executor.execute(call('fetch_url', { url: 'https://example.com' }), {
      conversation: conversation(),
      approval,
    })
    expect(approval).not.toHaveBeenCalled()

    for (const next of ['proactive', 'event', 'agent'] as const) {
      origin = next
      approval.mockClear()
      const result = await executor.execute(call('fetch_url', { url: 'https://example.com' }), {
        conversation: conversation(),
        approval,
      })
      expect(result).toBe(USER_DECLINED_RESULT)
      expect(approval).toHaveBeenCalledTimes(1)
    }
  })

  it('hand_off is a plain tool any conversation can use', async () => {
    const handoffs: Array<{ title: string; instructions: string }> = []
    const { executor } = createToolSystem(db, null, {
      handoff: (_ctx, item) => handoffs.push(item),
    })
    const result = await executor.execute(
      call('hand_off', { title: 'Pay the invoice', instructions: 'Card on file, total 450 SEK' }),
      { conversation: conversation(), approval: async () => DECLINE }
    )
    expect(result).toMatch(/stop at this step/)
    expect(handoffs).toEqual([{ title: 'Pay the invoice', instructions: 'Card on file, total 450 SEK' }])
  })
})

describe('sensitive browser fields', () => {
  it('turns a sensitive-field refusal into a handoff', async () => {
    db.settings.update({ browserToolsEnabled: true })
    const handoffs: string[] = []
    const fakeBrowser = {
      navigate: async () => 'ok',
      readPage: async () => '',
      back: async () => '',
      clickSelector: async () => '',
      typeText: async () => `${SENSITIVE_FIELD_SENTINEL} that field takes a password`,
      computer: async () => '',
      currentUrl: () => 'https://shop.example.com/checkout',
    }
    const { executor, registry } = createToolSystem(db, null, {
      browserEnabled: () => true,
      browser: fakeBrowser,
      handoff: (_ctx, item) => handoffs.push(item.instructions),
    })
    registry.setPermission('browser', 'always_allow')
    const result = await executor.execute(
      call('browser', { action: 'type', selector: '#pw', text: 'hunter2' }),
      { conversation: conversation(), approval: async () => APPROVE }
    )
    expect(result).not.toContain(SENSITIVE_FIELD_SENTINEL)
    expect(result).toMatch(/handed to them/)
    expect(handoffs[0]).toContain('shop.example.com')
  })

  it('fills a saved login through the vault without the password reaching the result', async () => {
    db.settings.update({ browserToolsEnabled: true })
    const vault = new LoginVault(db, keystore)
    vault.save({ origin: 'https://mail.example.com/login', username: 'me@example.com', password: 's3cr3t!' })
    const filled: Array<[string, string]> = []
    const fakeBrowser = {
      navigate: async () => 'ok',
      readPage: async () => '',
      back: async () => '',
      clickSelector: async () => '',
      typeText: async () => '',
      computer: async () => '',
      currentUrl: () => 'https://mail.example.com/login?next=/',
      fillLogin: async (u: string, p: string) => {
        filled.push([u, p])
        return 'Saved login filled and submitted.'
      },
    }
    const { executor, registry } = createToolSystem(db, null, {
      browserEnabled: () => true,
      browser: fakeBrowser,
      loginVault: vault,
    })
    registry.setPermission('browser', 'always_allow')
    const ctx = { conversation: conversation(), approval: async () => APPROVE }
    const list = await executor.execute(call('browser', { action: 'logins' }), ctx)
    expect(list).toContain('me@example.com')
    expect(list).not.toContain('s3cr3t!')
    const result = await executor.execute(call('browser', { action: 'login' }), ctx)
    expect(filled).toEqual([['me@example.com', 's3cr3t!']])
    expect(result).not.toContain('s3cr3t!')
    const log = db.activity.list({ limit: 5 }).entries
    expect(JSON.stringify(log)).not.toContain('s3cr3t!')
  })

  it('fills a saved login only into the site it belongs to', async () => {
    db.settings.update({ browserToolsEnabled: true })
    const vault = new LoginVault(db, keystore)
    vault.save({ origin: 'https://bank.example.com', username: 'me', password: 'bank-pw' })
    const filled: Array<[string, string, string]> = []
    let pageUrl = 'https://evil.example.net/phish'
    const { executor, registry } = createToolSystem(db, null, {
      browserEnabled: () => true,
      browser: {
        navigate: async () => 'ok',
        readPage: async () => '',
        back: async () => '',
        clickSelector: async () => '',
        typeText: async () => '',
        computer: async () => '',
        currentUrl: () => pageUrl,
        fillLogin: async (u: string, p: string, origin: string) => {
          filled.push([u, p, origin])
          return 'Saved login filled.'
        },
      },
      loginVault: vault,
      handoff: () => undefined,
    })
    registry.setPermission('browser', 'always_allow')
    const ctx = { conversation: conversation(), approval: async () => APPROVE }
    // An injected page asks for the bank login while showing its own form.
    const steered = await executor.execute(
      call('browser', { action: 'login', url: 'https://bank.example.com' }),
      ctx
    )
    expect(steered).toMatch(/only ever filled into the site it belongs to/)
    // Without a url the open page decides — and evil.example.net has no login.
    await executor.execute(call('browser', { action: 'login' }), ctx)
    expect(filled).toEqual([])
    // On the bank's own page the login fills, with the origin re-checked in-page.
    pageUrl = 'https://bank.example.com/login'
    await executor.execute(call('browser', { action: 'login' }), ctx)
    expect(filled).toEqual([['me', 'bank-pw', 'https://bank.example.com']])
  })

  it('never puts a sensitive field value into the page snapshot', () => {
    const element = (attrs: Record<string, string>, props: Record<string, unknown>) => ({
      tagName: 'INPUT',
      getAttribute: (name: string) => attrs[name] ?? null,
      getBoundingClientRect: () => ({ width: 100, height: 20, left: 0, top: 0, bottom: 20 }),
      ...props,
    })
    const nodes = [
      element({ type: 'password' }, { value: 'hunter2', placeholder: '', name: 'pw' }),
      element({ type: 'text', autocomplete: 'one-time-code' }, { value: '123456', name: 'otp' }),
      element({ type: 'text' }, { value: 'me@example.com', name: 'user' }),
    ]
    const snapshot = runInNewContext(buildSnapshotJs(40, 6000), {
      document: { title: 'Login', body: { innerText: 'Sign in' }, querySelectorAll: () => nodes },
      innerHeight: 800,
      location: { href: 'https://bank.example.com/login' },
    }) as { elements: Array<{ label: string }> }
    const text = JSON.stringify(snapshot)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('123456')
    expect(snapshot.elements[0].label).toBe('pw [value hidden]')
    expect(text).toContain('me@example.com') // ordinary fields keep their value
  })

  it('treats a channel turn from someone other than the owner as an outside event', async () => {
    db.toolRules.create({ toolId: 'fetch_url', effect: 'allow_if_requested', scope: 'global' })
    const { executor } = createToolSystem(db, null, {
      fetchImpl: (async () =>
        new Response('hello', { headers: { 'content-type': 'text/plain' } })) as typeof fetch,
    })
    const approval = vi.fn(async () => DECLINE)
    const result = await withInvocationPolicy(CHANNEL_EVENT_POLICY, () =>
      executor.execute(call('fetch_url', { url: 'https://example.com' }), {
        conversation: conversation(),
        approval,
      })
    )
    expect(result).toBe(USER_DECLINED_RESULT)
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it('a coalesced turn keeps the least trusted origin and the strictest sandbox', () => {
    expect(
      mergeInvocationPolicies(
        { origin: 'remote', deviceId: 'phone-1', autoAcceptEdits: false, sandboxLevel: 'full' },
        CHANNEL_EVENT_POLICY
      )
    ).toEqual({ origin: 'channel', deviceId: 'phone-1', autoAcceptEdits: false, sandboxLevel: 'workspace-write' })
    expect(
      mergeInvocationPolicies(CHANNEL_EVENT_POLICY, {
        origin: 'autonomous',
        autoAcceptEdits: false,
        sandboxLevel: 'read-only',
      })
    ).toEqual({ origin: 'channel', autoAcceptEdits: false, sandboxLevel: 'read-only' })
  })

  it('never lets a standing grant cover the real desktop', () => {
    const desktop = BUILTIN_TOOL_DEFINITIONS.find((d) => d.id === 'desktop')
    expect(desktop?.noStandingApproval).toBe(true)
  })

  it('hands off when no login is saved for the site', async () => {
    db.settings.update({ browserToolsEnabled: true })
    const handoffs: string[] = []
    const { executor, registry } = createToolSystem(db, null, {
      browserEnabled: () => true,
      browser: {
        navigate: async () => '',
        readPage: async () => '',
        back: async () => '',
        clickSelector: async () => '',
        typeText: async () => '',
        computer: async () => '',
        currentUrl: () => 'https://bank.example.com',
        fillLogin: async () => 'should not be called',
      },
      loginVault: new LoginVault(db, keystore),
      handoff: (_ctx, item) => handoffs.push(item.title),
    })
    registry.setPermission('browser', 'always_allow')
    const result = await executor.execute(call('browser', { action: 'login' }), {
      conversation: conversation(),
      approval: async () => APPROVE,
    })
    expect(result).toMatch(/handed to them/)
    expect(handoffs).toEqual(['Log in for your agent'])
  })

  it('waits while the user drives the browser and continues once control returns', async () => {
    db.settings.update({ browserToolsEnabled: true })
    let inControl = true
    let release: (value: boolean) => void = () => undefined
    const navigations: string[] = []
    const { executor, registry } = createToolSystem(db, null, {
      browserEnabled: () => true,
      browser: {
        navigate: async (url: string) => {
          navigations.push(url)
          return 'ok'
        },
        readPage: async () => '',
        back: async () => '',
        clickSelector: async () => '',
        typeText: async () => '',
        computer: async () => '',
        isUserInControl: () => inControl,
        waitForControl: () =>
          new Promise<boolean>((resolve) => {
            release = resolve
          }),
      },
    })
    registry.setPermission('browser', 'always_allow')
    db.toolRules.create({ toolId: 'browser', effect: 'allow', scope: 'global' })
    const pending = executor.execute(call('browser', { action: 'navigate', url: 'https://a.example.com' }), {
      conversation: conversation(),
      approval: async () => APPROVE,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(navigations).toEqual([])
    inControl = false
    release(true)
    expect(await pending).toBe('ok')
    expect(navigations).toEqual(['https://a.example.com'])
  })
})

describe('credential vault', () => {
  it('stores the password encrypted, prefers a bot login, and never lists the secret', () => {
    const vault = new LoginVault(db, keystore)
    const bot = db.agents.create({ name: 'Shopper', systemPrompt: 'p' })
    vault.save({ origin: 'https://shop.example.com', username: 'shared@x.se', password: 'one' })
    vault.save({
      origin: 'https://shop.example.com/',
      username: 'bot@x.se',
      password: 'two',
      agentId: bot.id,
    })
    expect(JSON.stringify(vault.list())).not.toMatch(/"one"|"two"/)
    expect(vault.resolve('https://shop.example.com/cart', bot.id)).toEqual({
      username: 'bot@x.se',
      password: 'two',
    })
    expect(vault.resolve('https://shop.example.com/cart', null)).toEqual({
      username: 'shared@x.se',
      password: 'one',
    })
    expect(vault.resolve('https://other.example.com', null)).toBeNull()
    // Re-saving the same login updates it instead of duplicating.
    vault.save({ origin: 'https://shop.example.com', username: 'shared@x.se', password: 'three' })
    expect(vault.list()).toHaveLength(2)
    expect(vault.resolve('https://shop.example.com', null)?.password).toBe('three')
    vault.removeForAgent(bot.id)
    expect(vault.list()).toHaveLength(1)
    expect(originOf('ftp://nope')).toBeNull()
  })
})

describe('read-only MCP connectors (Sentinel)', () => {
  it('trusts readOnlyHint only on a read-access server, where write tools are hidden', async () => {
    const connector: McpConnector = async () => ({
      listTools: async () => [
        { name: 'list_mail', description: '', inputSchema: {}, readOnly: true },
        { name: 'send_mail', description: '', inputSchema: {} },
      ],
      callTool: async () => ({ content: 'ok', isError: false }),
      close: async () => undefined,
    })
    const manager = new McpManager({
      db,
      keystore,
      broadcast: () => undefined,
      changedChannel: 'push:mcpServersChanged',
      connector,
    })
    await manager.create({ name: 'Mail', transport: 'stdio', command: 'mail-mcp' })
    // A server's own hint is an annotation, not a security decision: on a
    // write-access server every tool stays mutating (and outward).
    const writeDefs = manager.listToolDefinitions(() => true)
    expect(writeDefs.map((d) => [d.name.split('__').pop(), d.mutating])).toEqual([
      ['list_mail', true],
      ['send_mail', true],
    ])
    const [server] = db.mcpServers.list()
    await manager.update(server.id, { access: 'read' })
    // Read access = the user chose to trust this server's hints.
    const readDefs = manager.listToolDefinitions(() => true)
    expect(readDefs.map((d) => [d.name.split('__').pop(), d.mutating])).toEqual([['list_mail', false]])
    expect(db.mcpServers.getById(server.id)?.access).toBe('read')
  })
})

describe('auto-review', () => {
  it('parses verdicts leniently and fails safe to ask', () => {
    expect(parseReviewVerdict('{"verdict":"allow","reason":"fine"}')).toEqual({
      verdict: 'allow',
      reason: 'fine',
    })
    expect(parseReviewVerdict('Sure! {"verdict": "block", "reason": "exfiltration"} ok').verdict).toBe(
      'block'
    )
    expect(parseReviewVerdict('I think it is ok').verdict).toBe('ask')
    expect(parseReviewVerdict('{"verdict":"yolo"}').verdict).toBe('ask')
  })

  it('redacts secrets in the prompt and reports a failing reviewer as ask', async () => {
    const prompt = buildReviewPrompt({
      toolName: 'message_agent',
      argumentsJson: '{"message":"key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"}',
      origin: 'event',
      request: 'triage the new issue',
    })
    expect(prompt).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(prompt).toContain('untrusted')
    const failing = new AutoReviewer(async () => {
      throw new Error('provider down')
    })
    expect((await failing.review({ toolName: 't', argumentsJson: '{}', origin: 'agent', request: '' })).verdict).toBe('ask')
  })

  it('reviews outward calls that would auto-run: block refuses, ask goes to the dialog', async () => {
    const sends: string[] = []
    let verdict: 'allow' | 'ask' | 'block' = 'block'
    const reviewed: string[] = []
    const { executor } = createToolSystem(db, null, {
      botMessenger: {
        send: async (_c, target) => {
          sends.push(target)
          return 'queued'
        },
      },
      turnOrigin: () => 'agent',
      autoReview: async (_ctx, c) => {
        reviewed.push(c.toolName)
        return { verdict, reason: 'recipient was never mentioned' }
      },
    })
    const botConversation = conversation({ id: 'bot-conv', agentId: 'bot-1' })
    const approval = vi.fn(async () => DECLINE)
    const blocked = await executor.execute(call('message_agent', { target: 'X', message: 'hi' }), {
      conversation: botConversation,
      approval,
    })
    expect(blocked).toMatch(/Auto-review stopped/)
    expect(approval).not.toHaveBeenCalled()
    expect(db.activity.list({ limit: 1 }).entries[0].decision).toBe('reviewed')

    verdict = 'ask'
    const asked = await executor.execute(call('message_agent', { target: 'X', message: 'hi' }), {
      conversation: botConversation,
      approval,
    })
    expect(asked).toBe(USER_DECLINED_RESULT)
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ note: expect.stringContaining('recipient was never mentioned') })
    )

    verdict = 'allow'
    expect(
      await executor.execute(call('message_agent', { target: 'X', message: 'hi' }), {
        conversation: botConversation,
        approval,
      })
    ).toBe('queued')
    expect(sends).toEqual(['X'])
    // A non-outward tool is never sent to review.
    reviewed.length = 0
    await executor.execute(call('suggest_action', { title: 't', action: 'a' }), {
      conversation: botConversation,
      approval,
    })
    expect(reviewed).toEqual([])
  })
})

describe('handoff records', () => {
  it('records bot and ordinary-conversation handoffs, deduped, and "done" informs the bot', async () => {
    const sends: string[] = []
    const chat: BotChatService = {
      send: async ({ content }) => {
        sends.push(content)
        return {}
      },
      isConversationActive: () => false,
      compactNow: async () => ({ compacted: false }),
      generateForWorkflow: async () => '',
    }
    const notes: string[] = []
    const service = new BotService({
      db,
      chat,
      broadcast: () => undefined,
      notify: ({ title }) => notes.push(title),
    })
    const bot = db.agents.create({ name: 'Booker', systemPrompt: 'p' })
    const botChat = service.ensureBotChat(bot.id)
    const first = service.recordHandoff(botChat.id, { title: 'Pay hotel', instructions: 'Card step' })
    const again = service.recordHandoff(botChat.id, { title: 'pay hotel', instructions: 'Card step' })
    expect(again?.id).toBe(first?.id)
    expect(first?.kind).toBe('handoff')
    expect(notes[0]).toContain('Booker needs you')

    const plain = db.conversations.create({ mode: 'chat', title: 'plain' })
    const loose = service.recordHandoff(plain.id, { title: 'Sign the form', instructions: 'x' })
    expect(loose?.agentId).toBeNull()
    expect(db.botSuggestions.countAllOpen()).toBe(2)

    await service.acceptSuggestion(first!.id)
    expect(sends[0]).toMatch(/^\[Handoff done\] I completed "Pay hotel"/)
    await service.acceptSuggestion(loose!.id)
    expect(db.botSuggestions.countAllOpen()).toBe(0)
  })
})
