import { AsyncLocalStorage } from 'node:async_hooks'
import type { SandboxLevel } from '@shared/types'

export interface InvocationPolicy {
  deviceId?: string
  /** Only populated by the validated remote file-selection handler. */
  selectedPaths?: string[]
  /**
   * 'remote' = a paired phone; 'autonomous' (v53) = work nobody asked for in
   * the moment (a bot's proactive heartbeat), which runs at the policy's
   * sandbox level whatever the conversation's mode; 'channel' (v53) = a turn
   * an OUTSIDE party started through a bot channel (an email, a Slack /
   * Discord / Telegram group member who is not the owner) — the executor
   * treats it like an outside event: "act if requested" rules ask, outward
   * calls get auto-review, messaging a teammate asks.
   */
  origin: 'remote' | 'autonomous' | 'channel'
  autoAcceptEdits: false
  sandboxLevel: SandboxLevel
}

const invocationPolicy = new AsyncLocalStorage<InvocationPolicy>()

/** Runs one IPC invocation, including detached async work it starts, under a trusted policy. */
export function withInvocationPolicy<T>(policy: InvocationPolicy, run: () => T): T {
  return invocationPolicy.run(policy, run)
}

export function currentInvocationPolicy(): InvocationPolicy | undefined {
  return invocationPolicy.getStore()
}

/**
 * Runs `run` with NO policy. Timers and hooks inherit the async context they
 * were created in, so work that merely follows a restricted turn (a queued
 * follow-up turn, a completion hook starting a bot delivery) would otherwise
 * inherit that turn's restrictions — or its remote identity.
 */
export function withoutInvocationPolicy<T>(run: () => T): T {
  return invocationPolicy.exit(run)
}

/** Least trusted first: a coalesced turn keeps the least trusted origin. */
const ORIGIN_TRUST: Array<InvocationPolicy['origin']> = ['channel', 'autonomous', 'remote']

/** Coalesced work keeps the strictest originating policy. */
export function mergeInvocationPolicies(
  a: InvocationPolicy | undefined,
  b: InvocationPolicy | undefined
): InvocationPolicy | undefined {
  if (!a) return b
  if (!b) return a
  const levels: SandboxLevel[] = ['read-only', 'workspace-write', 'full']
  const deviceId = a.deviceId ?? b.deviceId
  return {
    ...a,
    ...(deviceId ? { deviceId } : {}),
    origin: ORIGIN_TRUST[Math.min(ORIGIN_TRUST.indexOf(a.origin), ORIGIN_TRUST.indexOf(b.origin))],
    sandboxLevel: levels[Math.min(levels.indexOf(a.sandboxLevel), levels.indexOf(b.sandboxLevel))],
  }
}

/** The policy a bot-channel turn from someone other than the owner runs under. */
export const CHANNEL_EVENT_POLICY: InvocationPolicy = {
  origin: 'channel',
  autoAcceptEdits: false,
  sandboxLevel: 'workspace-write',
}
