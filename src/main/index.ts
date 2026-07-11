/**
 * Main-process bootstrap: single-instance lock, database + services wiring,
 * IPC registration, window lifecycle, and production hardening (CSP,
 * navigation guards, sandboxed renderer).
 */

import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, Menu, Tray, app, globalShortcut, session, shell } from 'electron'
import { CHANNELS } from '@shared/ipc'
import { toRunSnippet } from '@shared/workflow-status'
import { openDatabase, type AppDatabase } from './db/database'
import { keystore } from './keys/keystore'
import { ChatService } from './services/chat-service'
import { ApprovalBroker } from './services/approval-broker'
import { QuestionBroker } from './services/question-broker'
import { seedBundledSkills } from './services/bundled-skills'
import { registerCompletionHook } from './services/completion-hooks'
import { createArtifactCompletionHook } from './services/artifact-hooks'
import { createMemoryCompletionHook } from './services/memory-hook'
import { DreamingService } from './services/dreaming'
import { CodeService } from './code/code-service'
import { GitService } from './code/git-service'
import { WorkspaceRootService } from './code/workspace-root'
import { createToolSystem, customToolDbId } from './tools'
import { McpManager } from './tools/mcp/manager'
import { ImBridgeManager } from './im/manager'
import { KnowledgeService } from './services/knowledge'
import { createWorkflowRunner, type WorkflowRunner } from './workflows/runner'
import { WorkflowScheduler } from './workflows/scheduler'
import { ScheduledTaskScheduler } from './scheduled-tasks/scheduler'
import { BrowserSession } from './browser/session'
import { OpenAiOAuthManager } from './providers/openai-oauth'
import { registerIpc } from './ipc/register'
import { ProjectHookService } from './services/project-hooks'

const PRODUCTION_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  // Design-mode prototypes render in a sandboxed srcdoc iframe (opaque origin).
  "frame-src 'self'"

let db: AppDatabase | null = null
let chatService: ChatService | null = null
let approvalBroker: ApprovalBroker | null = null
let questionBroker: QuestionBroker | null = null
let mcpManager: McpManager | null = null
let imBridgeManager: ImBridgeManager | null = null
let workflowScheduler: WorkflowScheduler | null = null
let scheduledTaskScheduler: ScheduledTaskScheduler | null = null
let dreamingService: DreamingService | null = null
let workflowRunnerRef: WorkflowRunner | null = null
/**
 * The app's main window. getAllWindows() must NOT be used to find it — the
 * hidden browser-tool window (BrowserSession) also lives there, and summoning
 * that one would reveal the sandboxed page the model drives.
 */
let mainWindow: BrowserWindow | null = null
let browserSession: BrowserSession | null = null
let oauthManager: OpenAiOAuthManager | null = null
let cleanedUp = false
let quitting = false

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/**
 * Idempotent teardown. Aborts in-flight generations and AWAITS their detached
 * loops so streamed text is persisted before the database closes, then resolves
 * pending tool approvals as declined and closes the db.
 */
async function cleanup(): Promise<void> {
  if (cleanedUp) return
  cleanedUp = true
  try {
    await chatService?.stopAll()
  } catch {
    // stopAll never rejects, but never let teardown throw.
  }
  // Resolve any pending tool approvals as declined so no executor promise
  // (and thus no tool) can outlive the user's session.
  approvalBroker?.stopAll()
  questionBroker?.stopAll()
  imBridgeManager?.stopAll()
  workflowScheduler?.stop()
  scheduledTaskScheduler?.stop()
  dreamingService?.stop()
  workflowRunnerRef?.stopAll()
  oauthManager?.stopAll()
  try {
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
  } catch {
    // Teardown conveniences only.
  }
  browserSession?.close()
  // Close MCP connections (kills any stdio child processes) before the db.
  try {
    await mcpManager?.stopAll()
  } catch {
    // stopAll never rejects; never let teardown throw.
  }
  try {
    db?.close()
  } catch {
    // Nothing actionable at quit time.
  }
}

/** Absolute file path of the app's bundled renderer entry (production). */
function rendererIndexPath(): string {
  return join(__dirname, '../renderer/index.html')
}

function isAllowedNavigation(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    try {
      return new URL(url).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  // Production: ONLY the app's own bundled index.html may load. A bare
  // `startsWith('file://')` allowed navigating to any local HTML (e.g. a
  // dropped file), which would run in the privileged renderer with the
  // window.uld preload attached and no effective CSP. Compare canonical paths.
  try {
    const target = new URL(url)
    if (target.protocol !== 'file:') return false
    const allowed = pathToFileURL(rendererIndexPath())
    return (
      decodeURIComponent(target.pathname).toLowerCase() ===
      decodeURIComponent(allowed.pathname).toLowerCase()
    )
  } catch {
    return false
  }
}

/** Restores + focuses the main window (creating one if none exists). */
function summonWindow(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Dev + packaged icon path; absent in packaged builds (exe icon applies). */
function appIconPath(): string {
  return join(__dirname, '../../build/icon.png')
}

/**
 * Tray icon + global summon shortcut: the assistant stays one keystroke away.
 * Skipped under SMOKE_TEST (no UI interaction there). The Tray instance must
 * be retained or it is garbage-collected away.
 */
let tray: Tray | null = null
function installQuickAccess(): void {
  if (process.env.SMOKE_TEST === '1') return
  try {
    const iconPath = appIconPath()
    if (existsSync(iconPath)) {
      tray = new Tray(iconPath)
      tray.setToolTip('Grasberg')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Open Grasberg', click: () => summonWindow() },
          { type: 'separator' },
          { label: 'Quit', click: () => app.quit() },
        ])
      )
      tray.on('click', () => summonWindow())
    }
  } catch {
    // A tray is a convenience — never block startup on it.
  }
  try {
    globalShortcut.register('CommandOrControl+Shift+G', () => summonWindow())
  } catch {
    // The shortcut may be taken by another app; the tray still works.
  }
}

function createWindow(): BrowserWindow {
  // In dev, __dirname is out/main, so ../../build resolves to the repo's build
  // dir. In a packaged app the window inherits the exe icon stamped by
  // electron-builder, so the file is absent here and we simply skip it.
  const iconPath = appIconPath()
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    show: false,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.once('ready-to-show', () => {
    if (process.env.SMOKE_TEST === '1') {
      console.log('SMOKE_OK')
      setTimeout(() => {
        void cleanup().finally(() => app.exit(0))
      }, 100)
      return
    }
    win.show()
  })

  // External links open in the system browser (https only); no child windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
      if (url.startsWith('https://')) void shell.openExternal(url)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(rendererIndexPath())
  }
  return win
}

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [PRODUCTION_CSP],
      },
    })
  })
}

function bootstrap(): void {
  if (app.isPackaged) installCsp()

  const dataDir = join(app.getPath('userData'), 'data')
  mkdirSync(dataDir, { recursive: true })
  const attachmentsDir = join(dataDir, 'attachments')
  mkdirSync(attachmentsDir, { recursive: true })
  // Per-task workspace folders for Work mode (created lazily per task).
  const workspacesDir = join(dataDir, 'workspaces')
  const worktreesDir = join(dataDir, 'worktrees')
  const database = openDatabase(join(dataDir, 'uld.sqlite3'))
  db = database
  // Recover generations interrupted by a crash or hard quit.
  database.messages.markDanglingStreamingAsStopped()
  // Seed the shipped skill library (no-op once seeded at the current version).
  // In dev the folder sits in the repo; packaged builds copy it next to the
  // asar via electron-builder extraResources.
  const bundledSkillsDir = app.isPackaged
    ? join(process.resourcesPath, 'bundled-skills')
    : join(app.getAppPath(), 'resources', 'bundled-skills')
  void seedBundledSkills(database, bundledSkillsDir)
  // Upgrade any keys still stored with the insecure fallback to real
  // safeStorage encryption now that Electron's crypto is available.
  keystore.reencryptInsecureKeys(database)

  const projectHooks = new ProjectHookService(database)
  const codeService = new CodeService(
    database,
    (projectId) => broadcast(CHANNELS.codeChangesChanged, { projectId }),
    (conversationId) => {
      const conversation = database.conversations.getById(conversationId)
      if (conversation) void projectHooks.run('afterApply', conversation)
    }
  )
  const workspaceRoots = new WorkspaceRootService(database, workspacesDir)
  // Mutating git lives ONLY in GitService; commit-message suggestions reuse
  // the headless one-shot generation path (default model, no tools).
  const gitService = new GitService({
    generateText: (prompt) =>
      chatService
        ? chatService.generateForWorkflow(prompt)
        : Promise.reject(new Error('Generation unavailable during startup.')),
    beforeCommit: (root) => projectHooks.runForRoot('beforeCommit', root),
  })
  // MCP manager: connects to user-configured MCP servers and exposes their
  // tools to the registry/executor. Connections open only on explicit enable
  // (and never under SMOKE_TEST).
  const mcp = new McpManager({
    db: database,
    keystore,
    broadcast,
    changedChannel: CHANNELS.mcpServersChanged,
  })
  mcpManager = mcp
  // One tool system per app: the registry/executor pair (read-only tools,
  // suggestions-only shell) plus the broker that routes per-call approvals
  // through the renderer. The chat service drives the tool loop with it.
  // Secret custom-tool headers are decrypted here (main only) at call time.
  const browser = new BrowserSession()
  browserSession = browser
  // Knowledge bases (RAG): embeddings go through chatService (set below) so
  // keys never leave main; the tool executor searches via this service.
  const knowledgeService = new KnowledgeService({
    db: database,
    embed: (providerId, modelId, texts) =>
      chatService
        ? chatService.embedTexts(providerId, modelId, texts)
        : Promise.reject(new Error('Embeddings unavailable during startup.')),
  })

  const toolSystem = createToolSystem(database, codeService, {
    mcp,
    knowledgeSearch: (kbId, query) => knowledgeService.search(kbId, query),
    shellEnabled: () => database.settings.get().shellExecutionEnabled,
    shellAllowlist: () => database.settings.get().shellCommandAllowlist,
    shellBackground: {
      start: (command, cwd) =>
        chatService
          ? chatService.startShellBackground(command, cwd)
          : 'Error: background shell jobs unavailable.',
    },
    browserEnabled: () => database.settings.get().browserToolsEnabled,
    browser,
    // Resolved at call time; chatService (below) is set before any generation.
    delegate: (task, ctx, agentName) =>
      chatService
        ? chatService.runDelegate(task, ctx, undefined, agentName)
        : Promise.resolve('Error: delegation unavailable.'),
    imageGeneration: {
      generate: (req) =>
        chatService
          ? chatService.generateImage(req)
          : Promise.reject(new Error('Image generation unavailable during startup.')),
    },
    gitWrite: {
      status: (root) => gitService.status(root),
      stage: (root, paths) => gitService.stage(root, paths),
      commit: (root, message) => gitService.commit(root, message),
      createBranch: (root, name) => gitService.createBranch(root, name),
    },
    delegateBackground: {
      start: (task, ctx, agentName) =>
        chatService
          ? chatService.startDelegateBackground(task, ctx, agentName)
          : 'Error: background tasks unavailable.',
      output: (taskId) =>
        chatService ? chatService.delegateTaskOutput(taskId) : 'Error: background tasks unavailable.',
      stop: (taskId) =>
        chatService ? chatService.delegateTaskStop(taskId) : 'Error: background tasks unavailable.',
    },
    // edit_file/write_file: propose + apply through the audited change
    // pipeline (path jail, staleness baseline, Changes-list record).
    codeChanges: {
      propose: (conversationId, relPath, changeType, newContent) =>
        codeService.proposeChange(conversationId, relPath, changeType, newContent),
      apply: (changeId) => codeService.applyChange(changeId),
    },
    // Work tasks without a folder get their own workspace on first write.
    ensureWorkspaceRoot: (conversationId) => workspaceRoots.ensure(conversationId),
    onScheduledTasksChanged: () => broadcast(CHANNELS.scheduledTasksChanged, {}),
    resolveSecretHeaders: (toolId) => {
      const out: Record<string, string> = {}
      for (const cipher of database.secrets.listCiphers('custom_tool', customToolDbId(toolId))) {
        try {
          out[cipher.name] = keystore.decryptKey(cipher.encryptedValue)
        } catch {
          // Skip an undecryptable secret rather than failing the whole call.
        }
      }
      return out
    },
  })
  const broker = new ApprovalBroker()
  approvalBroker = broker
  const questions = new QuestionBroker()
  questionBroker = questions
  // "Sign in with ChatGPT" OAuth manager (experimental). Tokens are encrypted
  // via the keystore; the browser is opened through the OS shell.
  const oauth = new OpenAiOAuthManager({
    repo: database.providers,
    encrypt: (plain) => keystore.encryptKey(plain).encryptedBase64,
    decrypt: (stored) => keystore.decryptKey(stored),
    openExternal: (url) => shell.openExternal(url),
  })
  oauthManager = oauth
  chatService = new ChatService(database, broadcast, {
    tools: { registry: toolSystem.registry, executor: toolSystem.executor, broker, questions },
    imageDir: attachmentsDir,
    browser,
    getAccessToken: (providerId) => oauth.getAccessToken(providerId),
  })

  const imBridge = new ImBridgeManager({
    db: database,
    keystore,
    generateReply: (conversationId, text) => chatService!.generateHeadless(conversationId, text),
  })
  imBridgeManager = imBridge

  // Saved-workflow execution (manual runs + the interval scheduler share it).
  const workflowRunner = createWorkflowRunner(
    database,
    {
      runAgent: (prompt, providerId, modelId, opts) =>
        chatService!.generateForWorkflow(prompt, providerId, modelId, opts),
      notify: (text) => imBridge.notify(text),
    },
    {
      // Keeps the Home overview / sidebar Scheduled section live the moment a
      // run lands (scheduled runs happen with no renderer request in flight).
      onRunRecorded: (run, workflow) =>
        broadcast(CHANNELS.workflowRunFinished, { run: toRunSnippet(run, workflow.name) }),
    }
  )
  const scheduler = new WorkflowScheduler({ db: database, runner: workflowRunner })
  workflowScheduler = scheduler
  workflowRunnerRef = workflowRunner

  const clockScheduler = new ScheduledTaskScheduler({
    db: database,
    run: (prompt) => chatService!.generateForWorkflow(prompt, undefined, undefined, { useTools: true }),
    onChanged: () => broadcast(CHANNELS.scheduledTasksChanged, {}),
  })
  scheduledTaskScheduler = clockScheduler

  // Dreaming: daily memory consolidation on the default model (settings-gated
  // inside the service; the manual Settings → Memory action bypasses gates).
  const dreaming = new DreamingService({
    db: database,
    generate: (prompt, opts) => chatService!.generateForWorkflow(prompt, undefined, undefined, opts),
  })
  dreamingService = dreaming

  // Mode-independent: persists ```uld-memory directives from every completed
  // assistant message (gated on settings.memoryEnabled inside the hook).
  registerCompletionHook(createMemoryCompletionHook(database))

  registerCompletionHook((conversation) => projectHooks.run('afterAgent', conversation))

  // Work-mode artifact side effects (proposed code changes, workspace items)
  // plus the generic outbound webhook.
  registerCompletionHook(
    createArtifactCompletionHook(database, codeService, imBridge, (conversationId) =>
      workspaceRoots.ensure(conversationId)
    )
  )

  registerIpc({
    db: database,
    chatService,
    codeService,
    gitService,
    keystore,
    toolSystem,
    approvalBroker: broker,
    questionBroker: questions,
    mcpManager: mcp,
    imBridgeManager: imBridge,
    oauthManager: oauth,
    workflowRunner,
    workspaceRoots,
    dreamingService: dreaming,
    knowledgeService,
    attachmentsDir,
    worktreesDir,
    getWindows: () => BrowserWindow.getAllWindows(),
  })

  // Connect enabled MCP servers + IM bridge in the background (no-op under SMOKE_TEST).
  void mcp.start()
  imBridge.start()
  if (process.env.SMOKE_TEST !== '1') {
    scheduler.start()
    clockScheduler.start()
    dreaming.start()
  }

  createWindow()
  installQuickAccess()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    summonWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Defer the quit until in-flight generations are aborted AND their detached
  // loops have persisted their partial text, then force-exit. preventDefault is
  // issued only on the first pass; the `quitting` guard blocks re-entry so we
  // never spin in a before-quit loop.
  app.on('before-quit', (event) => {
    if (cleanedUp) return
    if (quitting) {
      event.preventDefault()
      return
    }
    quitting = true
    event.preventDefault()
    void cleanup().finally(() => app.exit(0))
  })

  app
    .whenReady()
    .then(bootstrap)
    .catch((e: unknown) => {
      // Startup failures (e.g. corrupt database) — message never contains keys.
      console.error('Failed to start:', e instanceof Error ? e.message : String(e))
      void cleanup().finally(() => app.exit(1))
    })
}
