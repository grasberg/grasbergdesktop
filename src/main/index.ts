/**
 * Main-process bootstrap: single-instance lock, database + services wiring,
 * IPC registration, window lifecycle, and production hardening (CSP,
 * navigation guards, sandboxed renderer).
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, session, shell } from 'electron'
import { CHANNELS } from '@shared/ipc'
import { openDatabase, type AppDatabase } from './db/database'
import { keystore } from './keys/keystore'
import { ChatService } from './services/chat-service'
import { ApprovalBroker } from './services/approval-broker'
import { registerCompletionHook } from './services/completion-hooks'
import {
  extractDocument,
  extractHtmlArtifacts,
  extractWorkspaceItems,
} from './services/mode-artifacts'
import { CodeService } from './code/code-service'
import { createToolSystem, customToolDbId } from './tools'
import { McpManager } from './tools/mcp/manager'
import { ImBridgeManager } from './im/manager'
import { BrowserSession } from './browser/session'
import { registerIpc } from './ipc/register'

const PRODUCTION_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  // Design-mode prototypes render in a sandboxed srcdoc iframe (opaque origin).
  "frame-src 'self'"

let db: AppDatabase | null = null
let chatService: ChatService | null = null
let approvalBroker: ApprovalBroker | null = null
let mcpManager: McpManager | null = null
let imBridgeManager: ImBridgeManager | null = null
let browserSession: BrowserSession | null = null
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
  imBridgeManager?.stopAll()
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

function isAllowedNavigation(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    try {
      return new URL(url).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  return url.startsWith('file://')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
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
    void win.loadFile(join(__dirname, '../renderer/index.html'))
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
  const database = openDatabase(join(dataDir, 'uld.sqlite3'))
  db = database
  // Recover generations interrupted by a crash or hard quit.
  database.messages.markDanglingStreamingAsStopped()
  // Upgrade any keys still stored with the insecure fallback to real
  // safeStorage encryption now that Electron's crypto is available.
  keystore.reencryptInsecureKeys(database)

  const codeService = new CodeService(database)
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
  const toolSystem = createToolSystem(database, codeService, {
    mcp,
    shellEnabled: () => database.settings.get().shellExecutionEnabled,
    browserEnabled: () => database.settings.get().browserToolsEnabled,
    browser,
    // Resolved at call time; chatService (below) is set before any generation.
    delegate: (task, ctx) =>
      chatService
        ? chatService.runDelegate(task, ctx)
        : Promise.resolve('Error: delegation unavailable.'),
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
  chatService = new ChatService(database, broadcast, {
    tools: { registry: toolSystem.registry, executor: toolSystem.executor, broker },
    imageDir: attachmentsDir,
    browser,
  })

  // Mode side effects after each completed assistant message. Code mode
  // registers proposed file changes (nothing is written to disk here); the
  // renderer refreshes its change list when the stream 'done' event arrives,
  // so no extra push channel is needed. Cowork mode saves proposed workspace
  // items with origin 'assistant'.
  const imBridge = new ImBridgeManager({
    db: database,
    keystore,
    generateReply: (conversationId, text) => chatService!.generateHeadless(conversationId, text),
  })
  imBridgeManager = imBridge

  registerCompletionHook((conversation, message) => {
    if (message.role !== 'assistant' || message.content.trim().length === 0) return
    // Generic outbound webhook (best-effort) fires on every assistant message.
    void imBridge.onCompletion(conversation, message)
    if (conversation.mode === 'code' && conversation.projectId) {
      codeService.registerProposedChanges(conversation.id, message.content)
      return
    }
    if (conversation.mode === 'write') {
      const doc = extractDocument(message.content)
      if (doc) database.documents.upsertDoc(conversation.id, doc.title, doc.content)
      return
    }
    if (conversation.mode === 'design') {
      for (const html of extractHtmlArtifacts(message.content)) {
        database.documents.addHtml(conversation.id, html.title, html.content)
      }
      return
    }
    if (conversation.mode === 'cowork' && conversation.workspaceId) {
      for (const item of extractWorkspaceItems(message.content)) {
        database.workspaces.itemCreate({
          workspaceId: conversation.workspaceId,
          kind: item.kind,
          title: item.title,
          content: item.content,
          origin: 'assistant',
        })
      }
    }
  })

  registerIpc({
    db: database,
    chatService,
    codeService,
    keystore,
    toolSystem,
    approvalBroker: broker,
    mcpManager: mcp,
    imBridgeManager: imBridge,
    attachmentsDir,
    getWindows: () => BrowserWindow.getAllWindows(),
  })

  // Connect enabled MCP servers + IM bridge in the background (no-op under SMOKE_TEST).
  void mcp.start()
  imBridge.start()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
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
