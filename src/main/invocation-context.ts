import { AsyncLocalStorage } from 'node:async_hooks'
import type { SandboxLevel } from '@shared/types'

export interface InvocationPolicy {
  deviceId?: string
  /** Only populated by the validated remote file-selection handler. */
  selectedPaths?: string[]
  origin: 'remote'
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

/** Coalesced work keeps the strictest originating policy. */
export function mergeInvocationPolicies(
  a: InvocationPolicy | undefined,
  b: InvocationPolicy | undefined
): InvocationPolicy | undefined {
  if (!a) return b
  if (!b) return a
  const levels: SandboxLevel[] = ['read-only', 'workspace-write', 'full']
  return {
    ...a,
    sandboxLevel: levels[Math.min(levels.indexOf(a.sandboxLevel), levels.indexOf(b.sandboxLevel))],
  }
}
