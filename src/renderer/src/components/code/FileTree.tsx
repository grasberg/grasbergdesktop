import { useMemo, useState, type ReactElement } from 'react'
import type { FileTreeNode } from '@shared/types'
import { useCodeStore } from '@/stores/code'
import './code.css'

/** Files above this size get a size badge in the tree. */
const SIZE_BADGE_THRESHOLD = 100 * 1024
/** Above this many nodes we show a "large tree" note. */
const HUGE_TREE_THRESHOLD = 2500

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function countNodes(node: FileTreeNode): number {
  let n = 1
  for (const child of node.children ?? []) n += countNodes(child)
  return n
}

function DirNode({ node, depth }: { node: FileTreeNode; depth: number }): ReactElement {
  const [expanded, setExpanded] = useState(depth === 0)
  return (
    <li role="treeitem" aria-expanded={expanded}>
      <button
        type="button"
        className="code-tree-row code-tree-dir"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`code-tree-chevron ${expanded ? 'open' : ''}`} aria-hidden>
          ▸
        </span>
        <span className="code-tree-name" title={node.relPath}>
          {node.name}
        </span>
      </button>
      {expanded && (
        <ul className="code-tree-group" role="group">
          {(node.children ?? []).map((child) => (
            <TreeNode key={child.relPath} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

function FileNode({ node, depth }: { node: FileTreeNode; depth: number }): ReactElement {
  const selected = useCodeStore((s) => s.selectedPaths.includes(node.relPath))
  const toggleSelect = useCodeStore((s) => s.toggleSelect)
  const openFilePreview = useCodeStore((s) => s.openFilePreview)

  const large = (node.sizeBytes ?? 0) > SIZE_BADGE_THRESHOLD

  return (
    <li role="treeitem" aria-selected={selected}>
      <div
        className={`code-tree-row code-tree-file ${selected ? 'selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <input
          type="checkbox"
          className="code-tree-check"
          checked={selected}
          aria-label={`Select ${node.relPath} as context`}
          onChange={() => toggleSelect(node.relPath)}
        />
        <button
          type="button"
          className="code-tree-open"
          title={`Preview ${node.relPath}`}
          onClick={() => void openFilePreview(node.relPath)}
        >
          <span className="code-tree-name">{node.name}</span>
        </button>
        {large && node.sizeBytes !== undefined && (
          <span className="badge code-tree-size">{formatBytes(node.sizeBytes)}</span>
        )}
      </div>
    </li>
  )
}

function TreeNode({ node, depth }: { node: FileTreeNode; depth: number }): ReactElement {
  return node.type === 'dir' ? (
    <DirNode node={node} depth={depth} />
  ) : (
    <FileNode node={node} depth={depth} />
  )
}

/**
 * Recursive, read-only project tree. Checkboxes pick files as chat context;
 * clicking a file name opens the preview modal. The tree arrives pre-filtered
 * from the main process — nothing is hidden client-side.
 */
export default function FileTree(): ReactElement {
  const tree = useCodeStore((s) => s.tree)
  const loading = useCodeStore((s) => s.loadingTree)

  const totalNodes = useMemo(() => (tree ? countNodes(tree) : 0), [tree])

  if (loading && !tree) {
    return <div className="code-tree-empty">Reading folder…</div>
  }
  if (!tree) {
    return <div className="code-tree-empty">The file tree could not be loaded.</div>
  }

  // The root node is the project folder itself — render its children directly.
  const children = tree.children ?? []

  return (
    <div className="code-tree">
      {children.length === 0 ? (
        <div className="code-tree-empty">This folder is empty.</div>
      ) : (
        <ul className="code-tree-group code-tree-root" role="tree" aria-label="Project files">
          {children.map((child) => (
            <TreeNode key={child.relPath} node={child} depth={0} />
          ))}
        </ul>
      )}
      {totalNodes > HUGE_TREE_THRESHOLD && (
        <div className="code-tree-note" role="note">
          Large project — {totalNodes.toLocaleString()} entries shown; the tree may be truncated.
        </div>
      )}
    </div>
  )
}
