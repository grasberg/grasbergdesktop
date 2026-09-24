/**
 * Shared implementation behind the prompts/memories/skills stores, which are
 * otherwise byte-level triplicates: `load()` replaces the list (toasting on
 * failure), and every mutation re-loads the list on success.
 *
 * Kept as a partial factory (the actions, not the whole store): each store
 * keeps its own concretely-typed state key (`templates` / `memories` /
 * `skills`) and can add extra actions (skills adds `importFolder`).
 */

import type { IpcResult } from '@shared/ipc'
import { unwrap } from '@/api/uld'
import { toastError } from './ui'

/** The uniform window.uld.<namespace> surface the three stores talk to. */
interface SimpleListApi<Item, Input, Patch> {
  list(): Promise<IpcResult<Item[]>>
  create(input: Input): Promise<IpcResult<unknown>>
  update(id: string, patch: Patch): Promise<IpcResult<unknown>>
  delete(id: string): Promise<IpcResult<unknown>>
}

export interface SimpleListActions<Input, Patch> {
  load(): Promise<void>
  /** Mutations reject with a NormalizedError on failure (callers toast). */
  create(input: Input): Promise<void>
  update(id: string, patch: Patch): Promise<void>
  remove(id: string): Promise<void>
}

export function createSimpleListActions<Item, Input, Patch>(opts: {
  /** Entity plural for the load-failure toast, e.g. 'prompts'. */
  label: string
  api: () => SimpleListApi<Item, Input, Patch>
  /** Commits a loaded list to the store's state key (and marks it loaded). */
  onLoaded: (items: Item[]) => void
  /** Marks the store loaded after a failed load (the toast is shared). */
  onLoadFailed: () => void
}): SimpleListActions<Input, Patch> {
  const actions: SimpleListActions<Input, Patch> = {
    async load() {
      try {
        const items = await unwrap(opts.api().list())
        opts.onLoaded(items)
      } catch (e) {
        opts.onLoadFailed()
        toastError(`Failed to load ${opts.label}`, e)
      }
    },

    async create(input) {
      await unwrap(opts.api().create(input))
      await actions.load()
    },

    async update(id, patch) {
      await unwrap(opts.api().update(id, patch))
      await actions.load()
    },

    async remove(id) {
      await unwrap(opts.api().delete(id))
      await actions.load()
    },
  }
  return actions
}
