/**
 * Zustand store for notebooks: Home-level living Markdown documents the user
 * and the assistant both edit (Home → Notes card).
 */

import { create } from 'zustand'
import type { NotebookDocInput, NotebookDocPatch, NotebookDocSummary } from '@shared/types'
import { createSimpleListActions, type SimpleListActions } from './simple-list'

export interface DocumentsStoreState extends SimpleListActions<NotebookDocInput, NotebookDocPatch> {
  documents: NotebookDocSummary[]
  loaded: boolean
}

export const useDocumentsStore = create<DocumentsStoreState>()((set) => ({
  documents: [],
  loaded: false,

  ...createSimpleListActions<NotebookDocSummary, NotebookDocInput, NotebookDocPatch>({
    label: 'notes',
    api: () => window.uld.documents,
    onLoaded: (documents) => set({ documents, loaded: true }),
    onLoadFailed: () => set({ loaded: true }),
  }),
}))
