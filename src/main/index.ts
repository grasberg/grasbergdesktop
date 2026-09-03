/**
 * Main-process bootstrap: single-instance lock, database + services wiring,
 * IPC registration, window lifecycle, and production hardening (CSP,
 * navigation guards, sandboxed renderer).
 */

import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  dialog,
  globalShortcut,
  powerMonitor,
  session,
  shell,
  systemPreferences,
} from 'electron'
import { CHANNELS, type NavigateTarget } from '@shared/ipc'
import { toRunSnippet } from '@shared/workflow-status'
import { openDatabase, type AppDatabase } from './db/database'
import { redactSecrets } from './providers/redact'
import { keystore } from './keys/keystore'
import { ChatService } from './services/chat-service'
import { ApprovalBroker } from './services/approval-broker'
import { QuestionBroker } from './services/question-broker'
import { seedBundledSkills } from './services/bundled-skills'
import { registerCompletionHook } from './services/completion-hooks'
import { createArtifactCompletionHook } from './services/artifact-hooks'
import { BotService } from './services/bots'
import { createMemoryCompletionHook } from './services/memory-hook'
import { postRunWebhook } from './services/task-webhook'
import { DreamingService } from './services/dreaming'
import { BriefService, briefNotification } from './services/brief'
import { CodeService } from './code/code-service'
import { GitService } from './code/git-service'
import { WorkspaceRootService } from './code/workspace-root'
import { createToolSystem, customToolDbId } from './tools'
import { McpManager } from './tools/mcp/manager'
import { ImBridgeManager } from './im/manager'
import { BotChannelService } from './im/bot-channels'
import { KnowledgeService } from './services/knowledge'
import { createWorkflowRunner, type WorkflowRunner } from './workflows/runner'
import { WorkflowScheduler } from './workflows/scheduler'
import { WorkflowTriggerServer } from './workflows/trigger-server'
import { WorkflowWatcherService } from './workflows/watcher'
import { ScheduledTaskScheduler } from './scheduled-tasks/scheduler'
import { BrowserSession } from './browser/session'
import { QuickWindow } from './quick/quick-window'
import { TerminalService } from './terminal/terminal-service'
import { VoiceService } from './audio/voice-service'
import { ArenaService } from './services/arena'
import { OptimizerService } from './services/optimizer'
import { OpenAiOAuthManager } from './providers/openai-oauth'
import { registerIpc } from './ipc/register'
import { publishMainEvent, subscribeMainEvents } from './events'
import { RemoteService } from './remote/service'
import { wsSocketFactory } from './remote/ws-socket'
import { ProjectHookService } from './services/project-hooks'
import { ScheduledRunQueue } from './scheduling/run-queue'
import { runShell } from './tools/shell'
import {
  DesktopNotifier,
  approvalNotification,
  resultNotification,
  titleOnlyForPrivateSpace,
} from './services/notify'
import { AppLockService, windowPushAllowed } from './services/app-lock'
import { collectInboxItems, countUnreviewed } from './services/inbox'
import { installCrashLogging, logMainError } from './services/crash-log'

/** Wall-clock cap on one optimizer eval/test command execution. */
const OPTIMIZER_EVAL_TIMEOUT_MS = 10 * 60_000

const PRODUCTION_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  // Design-mode prototypes render in a sandboxed srcdoc iframe (opaque origin).
  "frame-src 'self'"

let db: AppDatabase | null = null
let chatService: ChatService | null = null
let botService: BotService | null = null
let botChannels: BotChannelService | null = null
let approvalBroker: ApprovalBroker | null = null
let questionBroker: QuestionBroker | null = null
let mcpManager: McpManager | null = null
let imBridgeManager: ImBridgeManager | null = null
let workflowScheduler: WorkflowScheduler | null = null
let triggerServer: WorkflowTriggerServer | null = null
let workflowWatcher: WorkflowWatcherService | null = null
let scheduledTaskScheduler: ScheduledTaskScheduler | null = null
let dreamingService: DreamingService | null = null
let briefService: BriefService | null = null
let workflowRunnerRef: WorkflowRunner | null = null
/**
 * The app's main window. getAllWindows() must NOT be used to find it — the
 * hidden browser-tool window (BrowserSession) also lives there, and summoning
 * that one would reveal the sandboxed page the model drives.
 */
let mainWindow: BrowserWindow | null = null
let browserSession: BrowserSession | null = null
let quickWindow: QuickWindow | null = null
let terminalService: TerminalService | null = null
let voiceService: VoiceService | null = null
let arenaService: ArenaService | null = null
let optimizerService: OptimizerService | null = null
let remoteService: RemoteService | null = null
let oauthManager: OpenAiOAuthManager | null = null
let notifier: DesktopNotifier | null = null
let appLockService: AppLockService | null = null
let cleanedUp = false
let quitting = false

function broadcast(channel: string, payload: unknown): void {
  publishMainEvent(channel, payload)
}

// Every renderer window is one subscriber of the main event bus; the remote
// (phone tunnel) service is another. Both therefore see the exact same pushes.
subscribeMainEvents((channel, payload) => {
  // While the app is locked, nothing but the lock-state change itself may
  // reach a window — a stream delta behind the lock screen is still a leak.
  if (appLockService && !windowPushAllowed(appLockService.isLocked(), channel)) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
})

/**
 * Notices main raises with no request in flight. A send is never replayed, so
 * one emitted before a renderer subscribed — a trigger endpoint that fails to
 * bind at startup does exactly that — would vanish. They are held until a
 * renderer has loaded, then flushed.
 */
const pendingNotices: Array<{ message: string; level: 'info' | 'error' }> = []
let rendererLoaded = false

function notice(message: string, level: 'info' | 'error'): void {
  if (!rendererLoaded) {
    pendingNotices.push({ message, level })
    return
  }
  broadcast(CHANNELS.mainNotice, { message, level })
}

/** A renderer is listening now — hand it whatever was raised before it was. */
function flushNotices(): void {
  rendererLoaded = true
  for (const held of pendingNotices.splice(0)) {
    broadcast(CHANNELS.mainNotice, held)
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
  botService?.stopMaintenance()
  botChannels?.stopAll()
  workflowScheduler?.stop()
  triggerServer?.stop()
  workflowWatcher?.stop()
  scheduledTaskScheduler?.stop()
  dreamingService?.stop()
  briefService?.stop()
  workflowRunnerRef?.stopAll()
  appLockService?.stop()
  oauthManager?.stopAll()
  try {
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
  } catch {
    // Teardown conveniences only.
  }
  browserSession?.close()
  quickWindow?.destroy()
  quickWindow = null
  // Kill every user terminal shell we spawned.
  terminalService?.disposeAll()
  // Abort any voice download and kill live whisper children.
  voiceService?.disposeAll()
  // Abort running arena candidates (their agent_runs settle as stopped).
  arenaService?.stopAll()
  // Abort running optimizer loops (their runs settle as stopped).
  optimizerService?.stopAll()
  // Drop the phone tunnel (revoked devices' keys are already gone).
  remoteService?.stopAll()
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
  // The user is here now — stop the taskbar flashing.
  notifier?.clearAttention()
}

/** A navigation requested while the app was locked; flushed on unlock. */
let pendingNavigate: NavigateTarget | null = null

/**
 * Summons the window and asks the renderer to open a conversation or bot room
 * (notification clicks, v49). Held back while locked — the lock screen must
 * never be bypassed by a deep link — and flushed by the unlock subscriber.
 */
function navigateTo(target: NavigateTarget): void {
  summonWindow()
  if (appLockService?.isLocked()) {
    pendingNavigate = target
    return
  }
  broadcast(CHANNELS.navigate, target)
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
  // Quick-assistant summon shortcut (self-guarded; toasts on failure).
  quickWindow?.syncShortcut()
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
  // Back in the app: stop the taskbar flashing and re-read the unread count.
  win.on('focus', () => {
    notifier?.clearAttention()
    notifier?.refreshBadge()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The hidden browser-tool window is a BrowserWindow too, so leaving it open
    // would keep 'window-all-closed' from ever firing (the app would live on
    // with no UI). It is recreated on demand by the next browser/computer call.
    browserSession?.close()
    // Same trap for the (possibly hidden) quick-assistant window.
    quickWindow?.destroy()
  })

  // The renderer's push subscriptions exist by the time the page has loaded, so
  // anything raised while it was still booting can be delivered now.
  win.webContents.on('did-finish-load', () => flushNotices())

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

/** The app's own renderer origin (dev server origin, or file: when packaged). */
function isAppOrigin(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  try {
    const target = new URL(url)
    if (devUrl) return target.origin === new URL(devUrl).origin
    return target.protocol === 'file:'
  } catch {
    return false
  }
}

/**
 * Deny-by-default permission policy for the main window's session. Electron
 * grants everything by default; the ONLY things this app's renderer needs are
 * clipboard writes (copy buttons), fullscreen, and — solely while voice input
 * is enabled — the microphone for push-to-talk. Everything else is denied.
 * Extend this allowlist deliberately, never wildcard. The hidden browser-tool
 * window uses its own partition with a deny-all handler (browser/session.ts)
 * and is untouched here.
 */
function installPermissionHandlers(database: AppDatabase): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const d = details as { requestingUrl?: string; mediaTypes?: string[] }
      const granted =
        isAppOrigin(d.requestingUrl ?? '') &&
        Array.isArray(d.mediaTypes) &&
        d.mediaTypes.length === 1 &&
        d.mediaTypes[0] === 'audio' &&
        database.settings.get().voiceInputEnabled
      if (granted && process.platform === 'darwin') {
        try {
          // Best-effort OS-level mic consent prompt.
          void systemPreferences.askForMediaAccess('microphone')
        } catch {
          // The renderer-level grant still stands; getUserMedia surfaces denial.
        }
      }
      callback(granted)
      return
    }
    if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') {
      callback(true)
      return
    }
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission === 'media') {
      const d = details as { mediaType?: string }
      return (
        (d.mediaType === undefined || d.mediaType === 'audio') &&
        isAppOrigin(requestingOrigin) &&
        database.settings.get().voiceInputEnabled
      )
    }
    return permission === 'clipboard-sanitized-write' || permission === 'fullscreen'
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
  // Same for background agent runs — their control-plane rows would otherwise
  // stay 'running' forever in the Agent Control Center.
  database.agentPlatform.markDanglingRunsAsStopped()
  // And for optimizer runs — a stuck 'running' row otherwise locks its project
  // out of new runs permanently (start() refuses while one is 'running', and
  // stop() can't reach a controller that died with the previous process).
  database.optimizer.markDanglingRunsAsStopped()
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

  // Deny-by-default permissions (mic only while voice input is on).
  installPermissionHandlers(database)

  // App lock: locks on launch when a passphrase is configured; idle checks
  // run on the shared 30 s clock pattern (skipped under SMOKE_TEST below).
  const appLock = new AppLockService({
    settings: database.settings,
    broadcast,
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  })
  appLockService = appLock

  // Private-space notification hygiene (v45): content from a private-space
  // conversation never reaches an OS notification body or the Telegram relay.
  const inPrivateSpace = (conversationId: string): boolean =>
    database.conversations.getById(conversationId)?.spaceId != null

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
        ? chatService.generateForWorkflow(prompt, undefined, undefined, { economy: true })
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
  // User-driven Work-view terminal sessions (pipes-based; killed on quit).
  const terminals = new TerminalService({ broadcast })
  terminalService = terminals
  // Offline voice: whisper.cpp binary/model downloads + push-to-talk STT.
  const voice = new VoiceService({
    db: database,
    audioDir: join(app.getPath('userData'), 'audio'),
    attachmentsDir,
    broadcast,
  })
  voiceService = voice
  // Code Arena: N models race the same task in isolated app-owned worktrees.
  const arena = new ArenaService({
    db: database,
    git: gitService,
    code: {
      openProject: (path) => codeService.openProject(path),
      proposeChange: (conversationId, relPath, changeType, newContent) =>
        codeService.proposeChange(conversationId, relPath, changeType, newContent),
      applyChangesAtomically: (changeIds) => codeService.applyChangesAtomically(changeIds),
    },
    worktreesDir,
    broadcast,
    generate: (prompt, providerId, modelId, opts) =>
      chatService
        ? chatService.generateForWorkflow(prompt, providerId, modelId, opts)
        : Promise.reject(new Error('Generation unavailable during startup.')),
  })
  arenaService = arena
  // Knowledge bases (RAG): embeddings go through chatService (set below) so
  // keys never leave main; the tool executor searches via this service.
  const knowledgeService = new KnowledgeService({
    db: database,
    embed: (providerId, modelId, texts, spaceId) =>
      chatService
        ? chatService.embedTexts(providerId, modelId, texts, spaceId)
        : Promise.reject(new Error('Embeddings unavailable during startup.')),
  })

  const toolSystem = createToolSystem(database, codeService, {
    mcp,
    knowledgeSearch: (kbId, query, spaceId) =>
      knowledgeService.search(kbId, query, undefined, spaceId),
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
    // Bot Mode: message_agent deliveries (botService is constructed below).
    botMessenger: {
      send: (senderConversationId, target, message) =>
        botService
          ? botService.messengerSend(senderConversationId, target, message)
          : Promise.resolve('Error: bot messaging unavailable.'),
    },
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
      setOrigin: (root, url) => gitService.setOrigin(root, url),
      fetch: (root) => gitService.fetch(root),
      pull: (root) => gitService.pull(root),
      push: (root, confirmDefaultBranch) => gitService.push(root, confirmDefaultBranch),
      createPullRequest: (root, input) => gitService.createPullRequest(root, input),
      reviewPullRequest: (root, input) => gitService.reviewPullRequest(root, input),
    },
    gitHub: {
      listIssues: (root, state) => gitService.listIssues(root, state),
      viewIssue: (root, issueNumber) => gitService.viewIssue(root, issueNumber),
      viewPullRequest: (root, prNumber) => gitService.viewPullRequest(root, prNumber),
      pullRequestDiff: (root, prNumber) => gitService.pullRequestDiff(root, prNumber),
      listCiRuns: (root) => gitService.listCiRuns(root),
      ciFailedLogs: (root, runId) => gitService.ciFailedLogs(root, runId),
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
    onDocumentsChanged: () => broadcast(CHANNELS.documentsChanged, {}),
    onToolRulesChanged: () => broadcast(CHANNELS.toolRulesChanged, undefined),
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
    // Bot Mode (v49): a delegation to a bot is a visible handoff — mirrored
    // into the bot's chat and marked in the caller's (botService is
    // constructed below; late-bound on purpose).
    onDelegateStarted: (info) => botService?.delegateStarted(info),
    onDelegateFinished: (info) => botService?.delegateFinished(info),
    imageDir: attachmentsDir,
    browser,
    getAccessToken: (providerId, signal) => oauth.getAccessToken(providerId, signal),
    // Headless runs (scheduled tasks, workflows) have no dialog to pop. With
    // remote approvals configured they ask the paired chat instead of silently
    // auto-declining. Resolved lazily: the bridge is constructed below.
    remoteApproval: (input) => {
      const bridge = imBridgeManager
      if (!bridge) return Promise.resolve(null)
      if (input.signal) {
        input.signal.addEventListener(
          'abort',
          () => bridge.cancelApproval(input.requestKey, 'The run was stopped.'),
          { once: true }
        )
      }
      return bridge.requestApproval(input.requestKey, {
        title: input.title,
        detail: input.detail,
      })
    },
    remoteChoice: (input) => {
      const bridge = imBridgeManager
      if (!bridge) return Promise.resolve(null)
      if (input.signal) {
        input.signal.addEventListener(
          'abort',
          () => bridge.cancelApproval(input.requestKey, 'The run was stopped.'),
          { once: true }
        )
      }
      return bridge.requestChoice(input.requestKey, {
        question: input.question,
        options: input.options,
      })
    },
    onBackgroundRunFinished: (info) => {
      notifier?.notify(
        titleOnlyForPrivateSpace(
          resultNotification(
            info.label,
            info.status === 'done' ? 'ok' : 'error',
            info.result || info.task,
            () => navigateTo({ conversationId: info.conversationId })
          ),
          inPrivateSpace(info.conversationId)
        )
      )
    },
  })

  const imBridge = new ImBridgeManager({
    db: database,
    keystore,
    generateReply: (conversationId, text) => chatService!.generateHeadless(conversationId, text),
  })
  imBridgeManager = imBridge

  // Desktop notifications + the unread badge. Every OS touchpoint is injected
  // so the routing rules stay testable in plain Node (services/notify.ts).
  const desktopNotifier = new DesktopNotifier({
    enabled: () =>
      process.env.SMOKE_TEST !== '1' &&
      Notification.isSupported() &&
      database.settings.get().desktopNotificationsEnabled &&
      // Muted while locked; the badge still refreshes (a count leaks nothing).
      !(appLockService?.isLocked() ?? false),
    windowFocused: () =>
      mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused(),
    show: ({ title, body, onClick }) => {
      const notification = new Notification({ title, body })
      notification.on('click', () => {
        summonWindow()
        onClick()
      })
      notification.show()
    },
    setBadge: (count) => {
      // Dock/Unity badge where the platform has one; the tray tooltip carries
      // the count everywhere else (Windows has no dock badge).
      app.setBadgeCount(count)
      tray?.setToolTip(count > 0 ? `Grasberg — ${count} to review` : 'Grasberg')
    },
    flash: (on) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
        mainWindow.flashFrame(on)
      }
    },
    // Inbox items to review plus bots/rooms that need the user or hold unread
    // bot messages (v49) — one honest number.
    unreadCount: () =>
      countUnreviewed(collectInboxItems(database)) + (botService?.attentionCount() ?? 0),
  })
  notifier = desktopNotifier

  // Bot Mode (v46): the roster/messaging/group-room service. Bot replies and
  // needs-you escalations surface as desktop notifications like every other
  // background result.
  const bots = new BotService({
    db: database,
    chat: chatService!,
    broadcast,
    notify: ({ title, body, conversationId, groupId }) => {
      desktopNotifier.notify({
        kind: 'result',
        title,
        body,
        onClick: () =>
          navigateTo({ conversationId: conversationId ?? null, groupId: groupId ?? null }),
      })
    },
    hasPendingFor: (conversationId) =>
      broker.hasPendingFor(conversationId) || questions.hasPendingFor(conversationId),
  })
  botService = bots
  // Durable deliveries (v48): settle whatever the previous process died in
  // the middle of and re-pump the queue. Runs after
  // markDanglingStreamingAsStopped (above), so an interrupted target turn
  // reads 'stopped', never 'streaming'.
  bots.recover()
  // Heartbeats + canonical-chat auto-compaction (v47), 60 s cadence.
  if (process.env.SMOKE_TEST !== '1') bots.startMaintenance()

  // Per-bot Telegram bindings (v47): each bound bot runs its own bridge;
  // inbound messages become canonical-chat turns (queue-if-busy) and replies
  // route back via the completion hook below.
  const botChannelService = new BotChannelService({
    db: database,
    keystore,
    ensureBotChat: (agentId) => bots.ensureBotChat(agentId),
    sendToBot: (conversationId, content) =>
      chatService!.send({ conversationId, content }, { queueIfBusy: true }),
    broadcast,
  })
  botChannels = botChannelService
  if (process.env.SMOKE_TEST !== '1') botChannelService.syncAll()

  // Optimizer: autonomous optimize-evaluate-commit loops per project (AVO
  // style). Eval commands run HERE, never through the agent's shell tool.
  const optimizer = new OptimizerService({
    db: database,
    git: gitService,
    generate: (prompt, providerId, modelId, opts) =>
      chatService
        ? chatService.generateForWorkflow(prompt, providerId, modelId, opts)
        : Promise.reject(new Error('Generation unavailable during startup.')),
    runCommand: async (command, cwd, signal) => {
      // keepTail: the score is the LAST number the benchmark prints, so a
      // verbose eval must not lose its final line to the output cap. Score off
      // stdout only — a stray number in a stderr warning must not become the
      // score. The aborted flag is surfaced so a stop mid-eval isn't recorded
      // as a genuine failed round.
      const result = await runShell(command, cwd, OPTIMIZER_EVAL_TIMEOUT_MS, signal, undefined, {
        keepTail: true,
      })
      return {
        ok: result.code === 0 && !result.timedOut && !result.aborted,
        exitCode: result.code,
        output: result.stdout,
        aborted: result.aborted,
      }
    },
    broadcast,
    notify: (notification) => desktopNotifier.notify(notification),
    worktreesDir,
  })
  optimizerService = optimizer

  // A pending approval is also pushed to the desktop and (when enabled) to the
  // paired Telegram chat. Both channels stay live at once and the first answer
  // wins — respond() ignores a requestId that already settled — so the user can
  // allow from the dialog or from their phone, whichever they reach first.
  broker.setHooks({
    onRequest: (request) => {
      const isPrivate = inPrivateSpace(request.conversationId)
      desktopNotifier.notify(
        titleOnlyForPrivateSpace(
          approvalNotification(request.toolCall.name, request.note, () =>
            navigateTo({ conversationId: request.conversationId })
          ),
          isPrivate
        )
      )
      // A private-space approval is never relayed to Telegram — the tool
      // arguments would otherwise leave the machine. The in-app dialog stands.
      if (isPrivate) return
      void imBridge
        .requestApproval(request.requestId, {
          title: `${request.toolCall.name} (${request.risk})`,
          detail: request.note
            ? `${request.note}\n\n${request.toolCall.arguments}`
            : request.toolCall.arguments,
        })
        .then((answer) => {
          // null = no channel / nobody answered: leave the in-app dialog alone.
          if (answer === null) return
          broker.respond(request.requestId, { approved: answer, scope: 'once' })
        })
    },
    onSettled: (requestId) => imBridge.cancelApproval(requestId),
  })

  // The same treatment for a question the assistant raised (ask_user_question):
  // a background or scheduled run can put a genuine fork to the user rather
  // than guessing, and the question follows them out of the app.
  questions.setHooks({
    onRequest: (request) => {
      const isPrivate = inPrivateSpace(request.conversationId)
      desktopNotifier.notify({
        kind: 'question',
        title: 'A task needs your input',
        body: isPrivate ? '' : request.question,
        onClick: () => navigateTo({ conversationId: request.conversationId }),
      })
      // Same rule as approvals: a private-space question never leaves the box.
      if (isPrivate) return
      void imBridge
        .requestChoice(request.requestId, {
          question: request.question,
          options: request.options,
        })
        .then((answer) => {
          if (answer === null) return
          questions.respond(request.requestId, answer)
        })
    },
    onSettled: (requestId) => imBridge.cancelApproval(requestId),
  })

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
      onRunRecorded: (run, workflow) => {
        broadcast(CHANNELS.workflowRunFinished, { run: toRunSnippet(run, workflow.name) })
        desktopNotifier.notify(
          resultNotification(
            workflow.name,
            run.status === 'ok' ? 'ok' : 'error',
            run.error ?? run.output ?? '',
            () => undefined
          )
        )
      },
    }
  )
  // The local trigger endpoint: an outside event (a git hook, a CI job) can
  // start a workflow. Loopback-only, token-gated, off until switched on, and
  // it starts only the workflows that individually opted in.
  const triggers = new WorkflowTriggerServer({
    settings: () => {
      const current = database.settings.get()
      return {
        enabled: current.workflowWebhookEnabled,
        port: current.workflowWebhookPort,
        token: current.workflowWebhookToken,
      }
    },
    isTriggerable: (workflowId) => database.workflows.getById(workflowId)?.webhookEnabled === true,
    run: (workflowId, trigger, payload) => workflowRunner.runById(workflowId, trigger, payload),
    onError: (message) => notice(message, 'error'),
  })
  triggerServer = triggers

  const scheduledRunQueue = new ScheduledRunQueue(2)
  const scheduler = new WorkflowScheduler({
    db: database,
    runner: workflowRunner,
    queue: scheduledRunQueue,
  })
  workflowScheduler = scheduler
  workflowRunnerRef = workflowRunner

  // Folder-watch triggers. Watched folders always came from the OS folder
  // picker (the user's grant); runs land in the same run history and notifier
  // via the runner's hooks, and share the scheduler's per-workflow queue key.
  const watcher = new WorkflowWatcherService({
    listWatched: () => database.workflows.listWatchedLite(),
    run: (id, trigger, payload) => workflowRunner.runById(id, trigger, payload),
    queue: scheduledRunQueue,
    onError: (_workflowId, message) => notice(message, 'error'),
  })
  workflowWatcher = watcher

  const clockScheduler = new ScheduledTaskScheduler({
    db: database,
    run: async (task) => {
      try {
        const output = await chatService!.generateForWorkflow(task.prompt, undefined, undefined, {
          useTools: true,
          approvedToolIds: task.approvedToolIds,
          projectId: task.projectId,
          usage: { runKind: 'scheduled_task', refId: task.id },
          // The task's owning agent profile: persona, model, toolset and its own
          // memories, so a recurring job accumulates context between runs.
          ...(task.agentId ? { agentId: task.agentId } : {}),
        })
        // Bot Mode: a routine owned by a bot reports into its canonical chat
        // (Hermes: "routines execute runs directly into the bot's chat").
        botService?.mirrorRoutineResult(task, 'ok', output)
        // Delivery target (v47): best-effort POST of the result, detached.
        if (task.webhookUrl) {
          void postRunWebhook(task.webhookUrl, {
            taskId: task.id,
            title: task.title,
            status: 'ok',
            output,
            error: null,
            finishedAt: Date.now(),
          })
        }
        return output
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        botService?.mirrorRoutineResult(task, 'error', message)
        if (task.webhookUrl) {
          void postRunWebhook(task.webhookUrl, {
            taskId: task.id,
            title: task.title,
            status: 'error',
            output: '',
            error: message,
            finishedAt: Date.now(),
          })
        }
        throw e
      }
    },
    onChanged: (event) => {
      broadcast(CHANNELS.scheduledTasksChanged, event)
      // Only a FINISHED run is worth a notification: the scheduler also emits
      // an upsert when a task starts (lastStatus 'running').
      if (
        event.type === 'upsert' &&
        (event.task.lastStatus === 'ok' || event.task.lastStatus === 'error')
      ) {
        desktopNotifier.notify(
          resultNotification(
            event.task.title,
            event.task.lastStatus,
            event.task.lastError ?? event.task.lastOutput,
            () => undefined
          )
        )
      }
    },
    queue: scheduledRunQueue,
  })
  scheduledTaskScheduler = clockScheduler

  // Dreaming: daily memory consolidation on the default model (settings-gated
  // inside the service; the manual Settings → Memory action bypasses gates).
  const dreaming = new DreamingService({
    db: database,
    generate: (prompt, opts) =>
      chatService!.generateForWorkflow(prompt, undefined, undefined, { ...opts, economy: true }),
  })
  dreamingService = dreaming

  // Morning brief: a once-daily digest of overnight results and today's
  // schedule (settings-gated inside the service; economy-routed unless an
  // agent profile is configured — agent profiles win inside generateForWorkflow).
  const brief = new BriefService({
    db: database,
    generate: (prompt, opts) =>
      chatService!.generateForWorkflow(prompt, undefined, undefined, {
        economy: true,
        usage: { runKind: 'brief' },
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
      }),
    onBrief: (b) => broadcast(CHANNELS.briefChanged, { brief: b }),
    notify: (b) => desktopNotifier.notify(briefNotification(b)),
    sendTelegram: (text) => imBridge.sendToOwner(text),
  })
  briefService = brief

  // Mode-independent: persists ```uld-memory directives from every completed
  // assistant message (gated on settings.memoryEnabled inside the hook).
  registerCompletionHook(createMemoryCompletionHook(database))

  // Bot Mode: routes finished bot-to-bot deliveries back to their senders and
  // drains queued deliveries when a bot's chat frees up.
  registerCompletionHook((conversation, message) =>
    botService?.handleCompletion(conversation, message)
  )

  // Bot bindings (v47): flushes finished turns back to their Telegram chats.
  registerCompletionHook((conversation, message) =>
    botChannels?.handleCompletion(conversation, message)
  )

  registerCompletionHook((conversation) => projectHooks.run('afterAgent', conversation))

  // Work-mode artifact side effects (proposed code changes, workspace items)
  // plus the generic outbound webhook.
  registerCompletionHook(
    createArtifactCompletionHook(database, codeService, imBridge, (conversationId) =>
      workspaceRoots.ensure(conversationId)
    )
  )

  // Quick assistant: frameless clipboard mini window on its own global
  // shortcut. The clipboard is read once per summon, held in memory only.
  const quick = new QuickWindow({
    readClipboardText: () => clipboard.readText(),
    getShortcut: () => database.settings.get().quickAssistantShortcut,
    onHidden: () => chatService?.stopQuickStream(),
    notice: (message, level) => notice(message, level),
    isLocked: () => appLock.isLocked(),
  })
  quickWindow = quick
  // The always-on-top quick window must never keep showing content over the
  // lock screen: hide it (which also aborts its stream) when the lock engages.
  subscribeMainEvents((channel, payload) => {
    if (channel === CHANNELS.appLockChanged && (payload as { locked?: boolean }).locked) {
      quick.hide()
    }
  })
  // Roster attention feeds the badge (v49) — every delivery, escalation and
  // mark-seen recomputes it; a navigation held during lock goes out on unlock.
  subscribeMainEvents((channel, payload) => {
    if (channel === CHANNELS.botsChanged) desktopNotifier.refreshBadge()
    if (
      channel === CHANNELS.appLockChanged &&
      !(payload as { locked?: boolean }).locked &&
      pendingNavigate
    ) {
      const target = pendingNavigate
      pendingNavigate = null
      broadcast(CHANNELS.navigate, target)
    }
  })

  const ipcHandlers = registerIpc({
    db: database,
    chatService,
    codeService,
    gitService,
    keystore,
    toolSystem,
    approvalBroker: broker,
    notifier: desktopNotifier,
    triggerServer: triggers,
    workflowWatcher: watcher,
    questionBroker: questions,
    botService: bots,
    botChannels: botChannelService,
    mcpManager: mcp,
    imBridgeManager: imBridge,
    oauthManager: oauth,
    workflowRunner,
    wakeWorkflowScheduler: () => scheduler.wake(),
    wakeScheduledTaskScheduler: () => clockScheduler.wake(),
    workspaceRoots,
    dreamingService: dreaming,
    briefService: brief,
    knowledgeService,
    attachmentsDir,
    worktreesDir,
    terminalService: terminals,
    voiceService: voice,
    arenaService: arena,
    optimizerService: optimizer,
    quickWindow: quick,
    summonMainWindow: () => summonWindow(),
    syncQuickShortcut: () => quick.syncShortcut(),
    getRemoteService: () => remoteService,
    getWindows: () => BrowserWindow.getAllWindows(),
    appLock,
  })

  // Remote access (phone tunnel): needs the handler map registerIpc built —
  // the phone invokes the very same handlers through its allowlist. The
  // service opens NO port; it dials the relay outbound and stays offline
  // until Settings turns it on (sync() re-reads settings, like the trigger
  // endpoint).
  const remote = new RemoteService({
    db: database,
    keystore,
    handlers: ipcHandlers,
    appVersion: app.getVersion(),
    socketFactory: wsSocketFactory,
    notice: (message, level) => notice(message, level),
    onChanged: () => broadcast(CHANNELS.remoteChanged, undefined),
  })
  remoteService = remote

  // Connect enabled MCP servers + IM bridge in the background (no-op under SMOKE_TEST).
  void mcp.start()
  imBridge.start()
  if (process.env.SMOKE_TEST !== '1') {
    scheduler.start()
    clockScheduler.start()
    dreaming.start()
    brief.start()
    // Idle auto-lock checks (self-guarded: no-op until a passphrase is set).
    appLock.start()
    // Binds only when the endpoint is switched on (it re-reads settings).
    triggers.sync()
    // Watches only workflows with an enabled watch config (self-guarded too).
    watcher.sync()
    // Dials the relay only when remote access is switched on (same pattern).
    remote.sync()
  }

  createWindow()
  installQuickAccess()
  // The tray exists now, so the badge/tooltip can show the startup count.
  desktopNotifier.refreshBadge()

  app.on('activate', () => {
    // Counting windows would count the hidden browser-tool one (see mainWindow).
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
}

/**
 * Startup failed (corrupt database, failed migration). A packaged build has no
 * console, so the user has to be told in a dialog — including where the
 * pre-migration snapshot the database layer leaves behind can be found.
 */
function showStartupFailure(message: string): void {
  if (process.env.SMOKE_TEST === '1') return
  try {
    const dataDir = join(app.getPath('userData'), 'data')
    const dbPath = join(dataDir, 'uld.sqlite3')
    const snapshot = (existsSync(dataDir) ? readdirSync(dataDir) : []).find(
      (name) => name.startsWith('uld.sqlite3.pre-v') && name.endsWith('.bak')
    )
    const recovery = snapshot
      ? `\n\nA pre-migration snapshot of the database exists:\n${join(dataDir, snapshot)}\n` +
        `With Grasberg closed, you can restore it by renaming that file over ${dbPath}.`
      : ''
    dialog.showErrorBox(
      'Grasberg could not start',
      `${message}\n\nDatabase: ${dbPath}${recovery}`
    )
  } catch {
    // A dialog is best-effort — the exit below happens either way.
  }
}

// Install crash logging before anything else can throw: a redacted main.log
// under userData is the only breadcrumb a packaged (console-less) build leaves.
try {
  installCrashLogging(app.getPath('userData'))
} catch {
  // Never let logging setup keep the app from starting.
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
      // Startup failures (e.g. corrupt database) — redacted before it is shown.
      const message = redactSecrets(e instanceof Error ? e.message : String(e))
      console.error('Failed to start:', message)
      logMainError('startup', e)
      showStartupFailure(message)
      void cleanup().finally(() => app.exit(1))
    })
}
