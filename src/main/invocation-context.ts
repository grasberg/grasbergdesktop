import { AsyncLocalStorage } from 'node:async_hooks'
import type { SandboxLevel } from '@shared/types'

export interface InvocationPolicy {
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
