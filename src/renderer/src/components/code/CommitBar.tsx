import { useState, type ReactElement } from 'react'
import { useCodeStore } from '@/stores/code'
import './code.css'

/**
 * Footer of the Changes panel: branch, staged/unstaged counts, stage-all,
 * commit-message box with a model-suggested draft, new-branch flow, and the
 * Commit button. Every action here is an explicit click — the click IS the
 * consent (no approval dialog). Hidden entirely for non-git projects.
 */
export default function CommitBar(): ReactElement | null {
  const gitStatus = useCodeStore((s) => s.gitStatus)
  const gitBusy = useCodeStore((s) => s.gitBusy)
  const gitStageAll = useCodeStore((s) => s.gitStageAll)
  const gitCommit = useCodeStore((s) => s.gitCommit)
  const gitCreateBranch = useCodeStore((s) => s.gitCreateBranch)
  const gitGenerateMessage = useCodeStore((s) => s.gitGenerateMessage)

  const [message, setMessage] = useState('')
  const [branchDraft, setBranchDraft] = useState<string | null>(null)
  const [confirmDefault, setConfirmDefault] = useState(false)

  if (!gitStatus || !gitStatus.isRepo) return null

  const staged = gitStatus.staged.length
  const unstagedTotal = gitStatus.unstaged.length + gitStatus.untracked.length
  const onDefault =
    gitStatus.branch !== null && gitStatus.branch === gitStatus.defaultBranch

  const commit = async (): Promise<void> => {
    if (onDefault && !confirmDefault) {
      setConfirmDefault(true)
      return
    }
    setConfirmDefault(false)
    if (await gitCommit(message.trim())) setMessage('')
  }

  return (
    <div className="commit-bar">
      <div className="commit-bar-status">
        <span
          className={`badge commit-bar-branch${onDefault ? ' commit-bar-branch-default' : ''}`}
          title={
            onDefault
              ? 'This is the repository’s default branch — consider a feature branch.'
              : 'Current branch'
          }
        >
          {gitStatus.detached ? 'detached HEAD' : (gitStatus.branch ?? 'no branch')}
          {onDefault ? ' (default)' : ''}
        </span>
        <span className="commit-bar-counts">
          {staged} staged · {unstagedTotal} unstaged
        </span>
        {unstagedTotal > 0 && (
          <button
            type="button"
            className="btn-link commit-bar-action"
            disabled={gitBusy}
            onClick={() => void gitStageAll()}
          >
            Stage all
          </button>
        )}
        {branchDraft === null ? (
          <button
            type="button"
            className="btn-link commit-bar-action"
            disabled={gitBusy}
            onClick={() => setBranchDraft('')}
          >
            New branch…
          </button>
        ) : (
          <span className="commit-bar-newbranch">
            <input
              className="input mono commit-bar-branch-input"
              value={branchDraft}
              placeholder="branch-name"
              spellCheck={false}
              autoFocus
              onChange={(e) => setBranchDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setBranchDraft(null)
                if (e.key === 'Enter' && branchDraft.trim()) {
                  void gitCreateBranch(branchDraft.trim()).then((ok) => {
                    if (ok) setBranchDraft(null)
                  })
                }
              }}
            />
            <button
              type="button"
              className="btn-link commit-bar-action"
              onClick={() => setBranchDraft(null)}
            >
              Cancel
            </button>
          </span>
        )}
      </div>

      <div className="commit-bar-compose">
        <textarea
          className="textarea commit-bar-message"
          rows={2}
          value={message}
          placeholder={staged > 0 ? 'Commit message…' : 'Stage files to commit'}
          disabled={gitBusy || staged === 0}
          onChange={(e) => {
            setMessage(e.target.value)
            setConfirmDefault(false)
          }}
        />
        <div className="commit-bar-buttons">
          <button
            type="button"
            className="btn btn-ghost"
            title="Suggest a message from the staged diff (uses your default model)"
            disabled={gitBusy || staged === 0}
            onClick={() =>
              void gitGenerateMessage().then((suggested) => {
                if (suggested) setMessage(suggested)
              })
            }
          >
            {gitBusy ? '…' : 'Generate'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={gitBusy || staged === 0 || message.trim().length === 0}
            onClick={() => void commit()}
          >
            {confirmDefault
              ? `Commit on ${gitStatus.branch}?`
              : `Commit${staged > 0 ? ` (${staged})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
