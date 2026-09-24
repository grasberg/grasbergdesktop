import { useEffect, useState, type ReactElement } from 'react'
import { useCodeStore } from '@/stores/code'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import './code.css'

/**
 * Footer of the Changes panel: branch, staged/unstaged counts, stage-all,
 * commit-message box with a model-suggested draft, new-branch flow, and the
 * Commit button. Every action here is an explicit click — the click IS the
 * consent (no approval dialog). Hidden entirely for non-git projects.
 */
export default function CommitBar(): ReactElement | null {
  const gitStatus = useCodeStore((s) => s.gitStatus)
  const projectId = useCodeStore(s => s.project?.id)
  const refresh = useCodeStore(s => s.loadGitStatus)
  useEffect(() => {
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectId, refresh])
  const gitBusy = useCodeStore((s) => s.gitBusy)
  const gitStageAll = useCodeStore((s) => s.gitStageAll)
  const gitCommit = useCodeStore((s) => s.gitCommit)
  const gitCreateBranch = useCodeStore((s) => s.gitCreateBranch)
  const gitGenerateMessage = useCodeStore((s) => s.gitGenerateMessage)
  const gitFetch = useCodeStore((s) => s.gitFetch)
  const gitSetOrigin = useCodeStore((s) => s.gitSetOrigin)
  const gitPull = useCodeStore((s) => s.gitPull)
  const gitPush = useCodeStore((s) => s.gitPush)
  const gitCreatePullRequest = useCodeStore((s) => s.gitCreatePullRequest)

  const [message, setMessage] = useState('')
  const [branchDraft, setBranchDraft] = useState<string | null>(null)
  const [confirmDefault, setConfirmDefault] = useState(false)
  const [confirmPushDefault, setConfirmPushDefault] = useState(false)
  const [prOpen, setPrOpen] = useState(false)
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [prDraft, setPrDraft] = useState(false)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [remoteDraft, setRemoteDraft] = useState<string | null>(null)
  useUnsavedChanges(!!message.trim() || !!branchDraft?.trim() || !!remoteDraft?.trim() || (prOpen && (!!prTitle.trim() || !!prBody.trim())))

  if (!gitStatus || !gitStatus.isRepo) return null

  const staged = gitStatus.staged.length
  const unstagedTotal = gitStatus.unstaged.length + gitStatus.untracked.length
  const onDefault =
    gitStatus.branch !== null && gitStatus.branch === gitStatus.defaultBranch
  const dirty = staged > 0 || unstagedTotal > 0

  const commit = async (): Promise<void> => {
    if (onDefault && !confirmDefault) {
      setConfirmDefault(true)
      return
    }
    setConfirmDefault(false)
    if (await gitCommit(message.trim())) setMessage('')
  }

  const push = async (): Promise<void> => {
    if (onDefault && !confirmPushDefault) {
      setConfirmPushDefault(true)
      return
    }
    if (await gitPush(confirmPushDefault)) setConfirmPushDefault(false)
  }

  const createPr = async (): Promise<void> => {
    const url = await gitCreatePullRequest({
      title: prTitle.trim(),
      body: prBody,
      base: gitStatus.defaultBranch ?? undefined,
      draft: prDraft,
    })
    if (url) setPrUrl(url)
  }

  return (
    <div className="commit-bar">
      <div className="commit-bar-status">
        <button type="button" className="btn-link commit-bar-action" disabled={gitBusy} onClick={() => void refresh()}>Refresh Git</button>
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
          {gitStatus.upstream
            ? ` · ${gitStatus.ahead} ahead / ${gitStatus.behind} behind`
            : gitStatus.hasOrigin
              ? ' · not pushed'
              : ' · local only'}
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
        {gitStatus.hasOrigin && (
          <>
            <button
              type="button"
              className="btn-link commit-bar-action"
              disabled={gitBusy}
              onClick={() => void gitFetch()}
            >
              Fetch
            </button>
            {gitStatus.upstream && gitStatus.behind > 0 && (
              <button
                type="button"
                className="btn-link commit-bar-action"
                title={dirty ? 'Commit or discard local changes before pulling.' : undefined}
                disabled={gitBusy || dirty}
                onClick={() => void gitPull()}
              >
                Pull ({gitStatus.behind})
              </button>
            )}
            {gitStatus.branch && (!gitStatus.upstream || gitStatus.ahead > 0) && (
              <button
                type="button"
                className="btn-link commit-bar-action"
                disabled={gitBusy}
                onClick={() => void push()}
              >
                {confirmPushDefault
                  ? `Push to ${gitStatus.branch}?`
                  : `Push${gitStatus.ahead > 0 ? ` (${gitStatus.ahead})` : ''}`}
              </button>
            )}
            {gitStatus.branch && !onDefault && gitStatus.upstream && (
              <button
                type="button"
                className="btn-link commit-bar-action"
                disabled={gitBusy || gitStatus.ahead > 0}
                title={gitStatus.ahead > 0 ? 'Push the latest commits first.' : undefined}
                onClick={() => {
                  setPrOpen((open) => !open)
                  setPrUrl(null)
                }}
              >
                Pull request…
              </button>
            )}
          </>
        )}
        {!gitStatus.hasOrigin &&
          (remoteDraft === null ? (
            <button
              type="button"
              className="btn-link commit-bar-action"
              disabled={gitBusy}
              onClick={() => setRemoteDraft('')}
            >
              Connect remote…
            </button>
          ) : (
            <span className="commit-bar-newbranch">
              <input
                className="input mono commit-bar-remote-input"
                value={remoteDraft}
                placeholder="https://github.com/owner/repo.git"
                spellCheck={false}
                autoFocus
                onChange={(event) => setRemoteDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRemoteDraft(null)
                  if (event.key === 'Enter' && remoteDraft.trim()) {
                    void gitSetOrigin(remoteDraft).then((ok) => {
                      if (ok) setRemoteDraft(null)
                    })
                  }
                }}
              />
              <button
                type="button"
                className="btn-link commit-bar-action"
                disabled={gitBusy || !remoteDraft.trim()}
                onClick={() =>
                  void gitSetOrigin(remoteDraft).then((ok) => {
                    if (ok) setRemoteDraft(null)
                  })
                }
              >
                Connect
              </button>
              <button
                type="button"
                className="btn-link commit-bar-action"
                onClick={() => setRemoteDraft(null)}
              >
                Cancel
              </button>
            </span>
          ))}
      </div>

      {prOpen && (
        <div className="commit-bar-pr">
          <input
            className="input"
            value={prTitle}
            maxLength={200}
            placeholder="Pull request title"
            onChange={(event) => setPrTitle(event.target.value)}
          />
          <textarea
            className="textarea"
            rows={3}
            value={prBody}
            maxLength={20_000}
            placeholder="Description (optional)"
            onChange={(event) => setPrBody(event.target.value)}
          />
          <div className="commit-bar-pr-actions">
            <label>
              <input
                type="checkbox"
                checked={prDraft}
                onChange={(event) => setPrDraft(event.target.checked)}
              />{' '}
              Draft
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={gitBusy || !prTitle.trim()}
              onClick={() => void createPr()}
            >
              Create pull request
            </button>
            {prUrl && (
              <a href={prUrl} target="_blank" rel="noreferrer">
                Open pull request
              </a>
            )}
          </div>
        </div>
      )}

      <div className="commit-bar-compose">
        <textarea
          className="textarea commit-bar-message"
          rows={2}
          value={message}
          placeholder={staged > 0 ? 'Commit message…' : 'Stage files to commit'}
          aria-label="Commit message"
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
