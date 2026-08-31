/**
 * Quick assistant window: a frameless, always-on-top mini BrowserWindow that
 * loads the app's own renderer with ?view=quick, summoned by a global
 * shortcut. Main reads the clipboard ONCE per summon and keeps a single
 * in-memory capture — never persisted, never logged. Everything the window
 * receives travels over TARGETED webContents.send, never the main event bus,
 * so ephemeral quick content can't leak to other windows or the phone tunnel.
 */

import { join } from 'node:path'
import { BrowserWindow, globalShortcut } from 'electron'
import { CHANNELS } from '@shared/ipc'
import type { QuickContext } from '@shared/types'
import { captureSelection } from '@shared/quick-actions'

export interface QuickWindowDeps {
  /** Electron 44's clipboard API is async; sync test doubles are fine too. */
  readClipboardText(): string | Promise<string>
  /** Current accelerator from settings; empty string = disabled. */
  getShortcut(): string
  /** Fires whenever the window hides — aborts the in-flight quick stream. */
  onHidden(): void
  notice(message: string, level: 'info' | 'error'): void
  /** App-lock state: while locked, summon is refused (hide still works). */
  isLocked?(): boolean
}

export class QuickWindow {
  private win: BrowserWindow | null = null
  private lastContext: QuickContext = { selectionText: '', truncated: false }
  private registeredAccelerator: string | null = null
  private destroyed = false

  constructor(private readonly deps: QuickWindowDeps) {}

  /** The shortcut handler: visible window → hide, otherwise summon. */
  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.hide()
    } else {
      this.summon()
    }
  }

  /** Captures the clipboard and shows the window (creating it on first use). */
  summon(): void {
    if (this.destroyed) return
    // The quick surface sits outside the register.ts lock gate and the
    // main-bus push suppression — while locked it must not open at all
    // (it would float above the lock screen showing the clipboard).
    if (this.deps.isLocked?.()) return
    const existed = this.win !== null && !this.win.isDestroyed()
    const win = this.ensureWindow()
    // The capture settles in milliseconds — far ahead of a first page load's
    // quick:getContext pull. On re-summon the fresh capture is pushed (the
    // first load pulls on mount instead, dodging the did-finish-load race).
    void Promise.resolve(this.deps.readClipboardText())
      .catch(() => '')
      .then((raw) => {
        this.lastContext = captureSelection(raw)
        if (existed) this.sendToQuick(CHANNELS.quickContext, this.lastContext)
      })
    if (existed) {
      win.show()
      win.focus()
    }
    // First summon: ready-to-show shows the window once the page is up.
  }

  /** Hides the window; the in-flight quick stream is aborted via onHidden. */
  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide()
    this.deps.onHidden()
  }

  /** Targeted send to the quick window only (no-op once it is gone). */
  sendToQuick(channel: string, payload: unknown): void {
    const win = this.win
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  /** The clipboard capture of the latest summon (served by quick:getContext). */
  getContext(): QuickContext {
    return this.lastContext
  }

  /**
   * (Re-)registers the summon accelerator from settings. Registration is
   * try/catch — another app may own the combo or the accelerator may be
   * invalid after a user edit — and a failure surfaces as a notice toast
   * instead of failing silently.
   */
  syncShortcut(): void {
    if (this.registeredAccelerator) {
      try {
        globalShortcut.unregister(this.registeredAccelerator)
      } catch {
        // Best-effort; re-registration below wins either way.
      }
      this.registeredAccelerator = null
    }
    if (this.destroyed) return
    const accelerator = this.deps.getShortcut().trim()
    if (!accelerator) return
    try {
      if (globalShortcut.register(accelerator, () => this.toggle())) {
        this.registeredAccelerator = accelerator
      } else {
        this.deps.notice(
          `The quick assistant shortcut ${accelerator} is unavailable (another app may own it).`,
          'error'
        )
      }
    } catch {
      this.deps.notice(`Invalid quick assistant shortcut: ${accelerator}`, 'error')
    }
  }

  /**
   * Tears the window down for good (main window closed, app quitting). A
   * lingering hidden BrowserWindow would keep 'window-all-closed' from ever
   * firing — the same trap as the browser-tool window. destroy() bypasses the
   * 'close' → hide interception.
   */
  destroy(): void {
    this.destroyed = true
    if (this.registeredAccelerator) {
      try {
        globalShortcut.unregister(this.registeredAccelerator)
      } catch {
        // Teardown convenience only.
      }
      this.registeredAccelerator = null
    }
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      width: 460,
      height: 560,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      show: false,
      backgroundColor: '#0f1115',
      // IDENTICAL sandbox webPreferences to the main window: the quick page is
      // the same bundled renderer (with window.uld) behind the same CSP.
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    this.win = win

    // The quick page never opens children and never navigates anywhere.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())

    // OS-close becomes hide (+ stream abort) while the app runs; destroy()
    // bypasses this on teardown.
    win.on('close', (event) => {
      event.preventDefault()
      this.hide()
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      void win.loadURL(`${devUrl}${devUrl.includes('?') ? '&' : '?'}view=quick`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { view: 'quick' } })
    }
    return win
  }
}
