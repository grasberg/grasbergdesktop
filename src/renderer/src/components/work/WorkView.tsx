/**
 * Work mode: the regular chat plus an on-demand workspace panel. A fresh Work
 * task looks like a plain chat (top controls + a thin rail); the panel opens
 * by itself the first time content appears — files (main links the task's
 * folder lazily on the first write; the settle-time conversation refresh in
 * the chat store carries the new projectId here), .html previews, or task
 * items. A manual collapse is sticky for the conversation.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { FileTreeNode } from '@shared/types'
import ChatView from '@/components/chat/ChatView'
import FilePreview from '@/components/code/FilePreview'
import { useOnGenerationSettled } from '@/hooks/useOnGenerationSettled'
import { useChatStore } from '@/stores/chat'
import { useCodeStore } from '@/stores/code'
import { useWorkspaceStore } from '@/stores/workspace'
import WorkControls from './WorkControls'
import WorkPanel, { type WorkTab } from './WorkPanel'
import './work.css'

function collectHtmlFiles(node: FileTreeNode | null): string[] {
  if (!node) return []
  const out: string[] = []
  const walk = (n: FileTreeNode): void => {
    if (n.type === 'file' && /\.html?$/i.test(n.name)) out.push(n.relPath)
    for (const child of n.children ?? []) walk(child)
  }
  walk(node)
  return out.sort()
}

export default function WorkView(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const project = useCodeStore((s) => s.project)
  const tree = useCodeStore((s) => s.tree)
  const items = useWorkspaceStore((s) => s.items)

  const conversationId = conversation?.id ?? null
  const projectId = conversation?.projectId ?? null
  const workspaceId = conversation?.workspaceId ?? null

  const [panelOpen, setPanelOpen] = useState(false)
  const [userCollapsed, setUserCollapsed] = useState(false)
  const [activeTab, setActiveTab] = useState<WorkTab>('files')
  const [selectedHtml, setSelectedHtml] = useState<string | null>(null)
  const [htmlReloadKey, setHtmlReloadKey] = useState(0)
  const prevHtmlRef = useRef<Set<string>>(new Set())

  const htmlFiles = useMemo(() => collectHtmlFiles(tree), [tree])

  // Per-conversation panel state: reset when switching tasks.
  useEffect(() => {
    setPanelOpen(false)
    setUserCollapsed(false)
    setActiveTab('files')
    setSelectedHtml(null)
    prevHtmlRef.current = new Set()
  }, [conversationId])

  // Resolve the linked folder whenever the conversation (or its projectId —
  // set by the connect flow, or lazily by main on the first write) changes.
  useEffect(() => {
    if (!conversationId) {
      useCodeStore.getState().reset()
      return
    }
    const conv = useChatStore.getState().conversation
    if (conv && conv.id === conversationId) {
      void useCodeStore.getState().loadForConversation(conv)
    }
  }, [conversationId, projectId])

  // Bind (never create) the workspace for the Tasks tab.
  useEffect(() => {
    const conv = useChatStore.getState().conversation
    void useWorkspaceStore
      .getState()
      .bindConversation(conv && conv.id === conversationId ? conv : null)
  }, [conversationId, workspaceId])

  // Refresh everything a generation may have produced: new diffs, files on
  // disk (approved edits write immediately), task items, and edited previews.
  useOnGenerationSettled(() => {
    void useCodeStore.getState().loadChanges()
    void useCodeStore.getState().loadTree()
    void useWorkspaceStore.getState().refresh()
    setHtmlReloadKey((k) => k + 1)
  })

  const hasProject = project !== null
  const hasItems = items.length > 0
  const hasHtml = htmlFiles.length > 0

  // Auto-open when content first appears; a manual collapse wins.
  useEffect(() => {
    if (panelOpen || userCollapsed) return
    if (hasHtml) {
      setPanelOpen(true)
      setActiveTab('preview')
      return
    }
    if (hasProject) {
      setPanelOpen(true)
      setActiveTab('files')
      return
    }
    if (hasItems) {
      setPanelOpen(true)
      setActiveTab('tasks')
    }
  }, [hasProject, hasItems, hasHtml, panelOpen, userCollapsed])

  // A brand-new .html file switches the panel to its preview.
  useEffect(() => {
    const prev = prevHtmlRef.current
    const fresh = htmlFiles.filter((p) => !prev.has(p))
    prevHtmlRef.current = new Set(htmlFiles)
    if (fresh.length === 0) return
    setSelectedHtml(fresh[fresh.length - 1])
    if (!userCollapsed) {
      setPanelOpen(true)
      setActiveTab('preview')
    }
  }, [htmlFiles, userCollapsed])

  const collapse = (): void => {
    setPanelOpen(false)
    setUserCollapsed(true)
  }
  const expand = (): void => {
    setPanelOpen(true)
    setUserCollapsed(false)
  }

  return (
    <div className="work-view">
      <section className="work-center" aria-label="Conversation">
        <WorkControls />
        <ChatView />
      </section>

      {panelOpen ? (
        <WorkPanel
          activeTab={activeTab}
          onTab={setActiveTab}
          onCollapse={collapse}
          hasProject={hasProject}
          htmlFiles={htmlFiles}
          selectedHtml={selectedHtml}
          onSelectHtml={setSelectedHtml}
          htmlReloadKey={htmlReloadKey}
          projectId={project?.id ?? null}
        />
      ) : (
        <div className="work-rail">
          <button
            type="button"
            className="work-rail-btn"
            aria-label="Show workspace panel"
            aria-expanded={false}
            title="Show workspace panel"
            onClick={expand}
          >
            <span aria-hidden>«</span>
            <span className="work-rail-label" aria-hidden>
              Workspace
            </span>
          </button>
        </div>
      )}

      <FilePreview />
    </div>
  )
}
