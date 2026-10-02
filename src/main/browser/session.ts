/**
 * Embedded, sandboxed browser the assistant can drive for the `browser` and
 * `computer` tools. It owns a hidden BrowserWindow (fixed 1280x800 viewport)
 * and controls it with built-in Electron APIs only — no native automation
 * dependency, and no access to the OS desktop. All navigation is http/https,
 * downloads are blocked, and it uses its own isolated session partition —
 * one per instance since v50, so a bot's browsing (cookies, history, the
 * page it is on) never collides with another bot's or the user's. Separate
 * screens, not a security boundary: every session is the same sandboxed
 * Chromium with the same posture.
 *
 * - `browser` tool  -> semantic actions (navigate/read/click/type/back).
 * - `computer` tool -> Anthropic-style coordinate actions on the same viewport,
 *   each leaving a screenshot the chat loop injects for vision models.
 */

import { BrowserWindow, session as electronSession } from 'electron'
import type { TeachStep } from '@shared/types'
import { buildSnapshotJs, IS_SENSITIVE_FIELD_JS, sensitiveFieldMessage } from './sensitive'
import { MAX_TEACH_STEPS, TEACH_RECORDER_JS, parseTeachEvent } from '../services/teach'

const VIEWPORT = { width: 1280, height: 800 }
const PARTITION = 'grasberg-browser' // non-persistent, isolated from the app
const NAV_TIMEOUT_MS = 20_000
const MAX_TEXT_CHARS = 6000
const MAX_ELEMENTS = 40
const SCREENSHOT_MAX_WIDTH = 1024
/** Live-view frames (v53) are small JPEGs — a watch window, not a recording. */
const FRAME_WIDTH = 720
const FRAME_JPEG_QUALITY = 60

export type ComputerAction =
  | 'screenshot'
  | 'cursor_position'
  | 'mouse_move'
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'left_click_drag'
  | 'scroll'
  | 'type'
  | 'key'
  | 'wait'

interface PageSnapshot {
  title: string
  url: string
  text: string
  elements: Array<{ tag: string; label: string; x: number; y: number }>
}

const SNAPSHOT_JS = buildSnapshotJs(MAX_ELEMENTS, MAX_TEXT_CHARS)

const MODIFIER_KEYS: Record<string, string> = {
  ctrl: 'control',
  control: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
}

/**
 * Splits a combo like 'ctrl+shift+a' into its final key plus the modifiers that
 * must ride ALONG WITH it: Chromium tracks no modifier state across synthetic
 * input events, so a modifier sent as its own keyDown does nothing.
 */
export function parseKeyCombo(combo: string): { keyCode: string; modifiers: string[] } {
  const tokens = combo
    .split('+')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const keyCode = tokens.pop() ?? ''
  const modifiers: string[] = []
  for (const token of tokens) {
    const modifier = MODIFIER_KEYS[token.toLowerCase()]
    if (modifier && !modifiers.includes(modifier)) modifiers.push(modifier)
  }
  return { keyCode, modifiers }
}

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** What the live view shows of one browser session (v53). */
export interface BrowserFrameState {
  open: boolean
  url: string
  title: string
  /** The user has taken over: the window is visible and the agent waits. */
  userControl: boolean
  /** JPEG data URL of the viewport, or null when nothing is open. */
  dataUrl: string | null
}

export class BrowserSession {
  private win: BrowserWindow | null = null
  private pendingScreenshot: string | null = null
  /** v53 take-over: while true the agent's actions wait for control to return. */
  private userControl = false
  private controlWaiters: Array<() => void> = []
  /** Called whenever control changes hands (main pushes it to the renderer). */
  onControlChange: ((userControl: boolean) => void) | null = null
  /** Window title while the user drives (names the bot when known). */
  label = 'Grasberg browser'
  /** v53 teach-a-task: the demonstration being recorded, with its listeners. */
  private recording: { steps: TeachStep[]; detach: () => void } | null = null

  /** `partition` names the isolated Chromium session this instance drives. */
  constructor(readonly partition: string = PARTITION) {}

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const ses = electronSession.fromPartition(this.partition)
    // Block downloads and deny all permission requests in the browsing session.
    // The partition Session is process-global and cached across window (and
    // BrowserSession) recreations, so guard on the session's own listener state
    // rather than an instance flag — 'will-download' handlers never accumulate.
    // setPermissionRequestHandler is a setter and idempotent.
    if (ses.listenerCount('will-download') === 0) {
      ses.on('will-download', (event) => event.preventDefault())
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    }
    const win = new BrowserWindow({
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        partition: this.partition,
      },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Closing the window while the user drives hands control back instead of
    // destroying the session (cookies, the page the agent was on).
    win.on('close', (event) => {
      if (this.userControl) {
        event.preventDefault()
        this.returnControl()
      }
    })
    this.win = win
    return win
  }

  // -- take over / live view (v53) ----------------------------------------------

  isUserInControl(): boolean {
    return this.userControl
  }

  /** The page the session is on, or null when nothing has been opened. */
  currentUrl(): string | null {
    if (!this.win || this.win.isDestroyed()) return null
    return this.win.webContents.getURL() || null
  }

  /**
   * The user takes the wheel (dots "Take over"): the agent's window becomes a
   * normal visible window and every browser/computer action waits until the
   * user returns control (button or closing the window).
   */
  takeOver(): void {
    const win = this.ensureWindow()
    if (!win.webContents.getURL()) void win.webContents.loadURL('about:blank')
    this.userControl = true
    win.setTitle(`${this.label} — you are in control (close to hand back)`)
    win.show()
    win.focus()
    this.onControlChange?.(true)
  }

  returnControl(): void {
    if (!this.userControl) return
    this.userControl = false
    if (this.win && !this.win.isDestroyed()) this.win.hide()
    const waiters = this.controlWaiters
    this.controlWaiters = []
    for (const resolve of waiters) resolve()
    this.onControlChange?.(false)
  }

  /**
   * Teach-a-task (v53): records the user's demonstration — page loads from
   * the webContents, clicks / field changes / submits from an injected
   * recorder that reports over console.debug. Secrets are never recorded.
   */
  startRecording(): void {
    this.stopRecording()
    const win = this.ensureWindow()
    const wc = win.webContents
    const steps: TeachStep[] = []
    const push = (step: TeachStep): void => {
      if (steps.length < MAX_TEACH_STEPS) steps.push(step)
    }
    const inject = (): void => {
      void wc.executeJavaScript(TEACH_RECORDER_JS, true).catch(() => undefined)
    }
    const onNavigate = (_event: unknown, url: string): void => {
      if (!/^https?:/i.test(url)) return
      push({ kind: 'navigate', url, selector: '', label: '', tag: '', value: null, secret: false, at: Date.now() })
    }
    const onConsole = (details: { message?: string }): void => {
      const step = parseTeachEvent(details.message ?? '', wc.getURL(), Date.now())
      if (step) push(step)
    }
    wc.on('did-navigate', onNavigate)
    wc.on('did-finish-load', inject)
    wc.on('console-message', onConsole)
    inject()
    this.recording = {
      steps,
      detach: () => {
        wc.removeListener('did-navigate', onNavigate)
        wc.removeListener('did-finish-load', inject)
        wc.removeListener('console-message', onConsole)
      },
    }
  }

  stopRecording(): TeachStep[] {
    const current = this.recording
    if (!current) return []
    this.recording = null
    if (this.win && !this.win.isDestroyed()) current.detach()
    return current.steps
  }

  /** Resolves true once the agent has control (immediately if it already has). */
  waitForControl(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.userControl) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.controlWaiters = this.controlWaiters.filter((fn) => fn !== onReturn)
        resolve(value)
      }
      const onReturn = (): void => done(true)
      const onAbort = (): void => done(false)
      const timer = setTimeout(() => done(false), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.controlWaiters.push(onReturn)
    })
  }

  /** One live-view frame: a small JPEG of the viewport plus where it is. */
  async frame(): Promise<BrowserFrameState> {
    if (!this.win || this.win.isDestroyed()) {
      return { open: false, url: '', title: '', userControl: this.userControl, dataUrl: null }
    }
    const wc = this.win.webContents
    let dataUrl: string | null = null
    try {
      const image = await wc.capturePage()
      if (!image.isEmpty()) {
        const sized = image.getSize().width > FRAME_WIDTH ? image.resize({ width: FRAME_WIDTH }) : image
        dataUrl = `data:image/jpeg;base64,${sized.toJPEG(FRAME_JPEG_QUALITY).toString('base64')}`
      }
    } catch {
      dataUrl = null
    }
    return {
      open: true,
      url: wc.getURL(),
      title: wc.getTitle(),
      userControl: this.userControl,
      dataUrl,
    }
  }

  /**
   * Fills a saved login on the current page (credential vault, v53). The
   * values go straight into the page's inputs — they are never returned, and
   * the result only says what happened. Submits the form when it can.
   */
  async fillLogin(username: string, password: string, expectedOrigin: string): Promise<string> {
    if (!this.win || this.win.isDestroyed()) return 'Error: no page is open. Navigate to the login page first.'
    // The origin is re-checked INSIDE the page, at the moment of typing, so a
    // navigation between the vault lookup and the fill can't redirect a saved
    // password to another site.
    const js = `(() => {
      if (location.origin !== ${JSON.stringify(expectedOrigin)}) return 'wrong-origin';
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const pass = Array.from(document.querySelectorAll('input[type=password]')).find(visible);
      if (!pass) return 'no-password-field';
      const form = pass.form || document;
      const candidates = Array.from(form.querySelectorAll('input')).filter((el) => visible(el) &&
        /^(text|email|tel|)$/i.test(el.getAttribute('type') || '') && el !== pass);
      const user = candidates.find((el) => /user|email|login|account/i.test((el.name||'') + (el.id||'') + (el.getAttribute('autocomplete')||''))) || candidates[0];
      const set = (el, value) => {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (user) set(user, ${JSON.stringify(username)});
      set(pass, ${JSON.stringify(password)});
      const submit = pass.form && (pass.form.querySelector('button[type=submit],input[type=submit]') || pass.form.querySelector('button'));
      if (submit) { submit.click(); return user ? 'filled-submitted' : 'password-only-submitted'; }
      if (pass.form && pass.form.requestSubmit) { pass.form.requestSubmit(); return 'filled-submitted'; }
      return user ? 'filled' : 'password-only';
    })()`
    let outcome: string
    try {
      outcome = (await this.win.webContents.executeJavaScript(js, true)) as string
    } catch {
      return 'Error: could not fill the login form on this page.'
    }
    if (outcome === 'wrong-origin') {
      return 'Error: the page changed to another site before the login could be filled. Nothing was typed.'
    }
    if (outcome === 'no-password-field') {
      return 'No password field is visible on this page — open the login form first.'
    }
    await new Promise((r) => setTimeout(r, 1200))
    if (!this.win || this.win.isDestroyed()) return 'Saved login filled; the window has since closed.'
    let where = await this.snapshotText(this.win)
    // Belt and braces: whatever the page echoes, the secret never leaves main.
    if (password.length >= 3) where = where.split(password).join('••••')
    const verb = outcome.includes('submitted') ? 'filled and submitted' : 'filled'
    return `Saved login ${verb} (the password was entered by the app; you never see it).\n\n${where}`
  }

  private async waitForLoad(win: BrowserWindow): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        // `once` removes whichever listener fired; drop the sibling too so
        // neither accumulates across navigations.
        win.webContents.removeListener('did-finish-load', finish)
        win.webContents.removeListener('did-fail-load', finish)
        resolve()
      }
      const timer = setTimeout(finish, NAV_TIMEOUT_MS)
      win.webContents.once('did-finish-load', finish)
      win.webContents.once('did-fail-load', finish)
    })
  }

  private async snapshotText(win: BrowserWindow): Promise<string> {
    let snap: PageSnapshot
    try {
      snap = (await win.webContents.executeJavaScript(SNAPSHOT_JS, true)) as PageSnapshot
    } catch {
      return `Page: ${win.webContents.getTitle()}\nURL: ${win.webContents.getURL()}\n(could not read the page contents)`
    }
    const lines: string[] = [`Page: ${snap.title}`, `URL: ${snap.url}`, '']
    if (snap.elements.length > 0) {
      lines.push('Interactive elements ([x,y] center — click by coordinate with the computer tool, or by selector/text with the browser tool):')
      for (const el of snap.elements) lines.push(`- [${el.x},${el.y}] ${el.tag} "${el.label}"`)
      lines.push('')
    }
    lines.push('Visible text:', snap.text)
    return lines.join('\n')
  }

  // -- browser (semantic) tool ------------------------------------------------

  async navigate(url: string): Promise<string> {
    const target = url.trim()
    if (!isAllowedUrl(target)) return `Error: only http/https URLs are allowed (got "${target}").`
    const win = this.ensureWindow()
    try {
      const loaded = win.webContents.loadURL(target)
      await Promise.race([loaded.catch(() => undefined), this.waitForLoad(win)])
    } catch {
      // did-fail-load handled above; still snapshot what we have
    }
    return this.snapshotText(win)
  }

  async readPage(): Promise<string> {
    if (!this.win || this.win.isDestroyed()) return 'Error: no page is open. Navigate first.'
    return this.snapshotText(this.win)
  }

  async back(): Promise<string> {
    if (!this.win || this.win.isDestroyed()) return 'Error: no page is open.'
    if (this.win.webContents.navigationHistory.canGoBack()) {
      this.win.webContents.navigationHistory.goBack()
      await this.waitForLoad(this.win)
    }
    return this.snapshotText(this.win)
  }

  async clickSelector(selector: string, byText: boolean): Promise<string> {
    if (!this.win || this.win.isDestroyed()) return 'Error: no page is open.'
    const js = byText
      ? `(() => { const t = ${JSON.stringify(selector)}.toLowerCase();
           const el = Array.from(document.querySelectorAll('a,button,[role=button],input[type=submit]'))
             .find(e => (e.innerText||e.value||'').trim().toLowerCase().includes(t));
           if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)});
           if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`
    let ok = false
    try {
      ok = (await this.win.webContents.executeJavaScript(js, true)) as boolean
    } catch {
      return `Error: could not click ${byText ? 'text' : 'selector'} "${selector}".`
    }
    if (!ok) return `No element matched ${byText ? 'text' : 'selector'} "${selector}".`
    await new Promise((r) => setTimeout(r, 500))
    return this.snapshotText(this.win)
  }

  async typeText(selector: string, text: string): Promise<string> {
    if (!this.win || this.win.isDestroyed()) return 'Error: no page is open.'
    // Passwords / one-time codes / card details stay with the user (v53).
    const js = `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if ((${IS_SENSITIVE_FIELD_JS})(el)) return 'sensitive';
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`
    let ok: boolean | string = false
    try {
      ok = (await this.win.webContents.executeJavaScript(js, true)) as boolean | string
    } catch {
      return `Error: could not type into "${selector}".`
    }
    if (ok === 'sensitive') return sensitiveFieldMessage('type')
    if (!ok) return `No input matched selector "${selector}".`
    return this.snapshotText(this.win)
  }

  // -- computer (coordinate) tool ---------------------------------------------

  private async screenshotDataUrl(win: BrowserWindow): Promise<string> {
    const image = await win.webContents.capturePage()
    const resized = image.getSize().width > SCREENSHOT_MAX_WIDTH
      ? image.resize({ width: SCREENSHOT_MAX_WIDTH })
      : image
    return `data:image/png;base64,${resized.toPNG().toString('base64')}`
  }

  consumePendingScreenshot(): string | null {
    const s = this.pendingScreenshot
    this.pendingScreenshot = null
    return s
  }

  async computer(action: ComputerAction, coordinate?: [number, number], text?: string): Promise<string> {
    const win = this.ensureWindow()
    const wc = win.webContents
    const [x, y] = coordinate ?? [0, 0]
    const clickAt = (button: 'left' | 'right' | 'middle', clickCount = 1): void => {
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount })
    }
    try {
      switch (action) {
        case 'screenshot':
        case 'cursor_position':
        case 'wait':
          break
        case 'mouse_move':
          wc.sendInputEvent({ type: 'mouseMove', x, y })
          break
        case 'left_click':
          clickAt('left')
          break
        case 'right_click':
          clickAt('right')
          break
        case 'middle_click':
          clickAt('middle')
          break
        case 'double_click':
          clickAt('left', 2)
          break
        case 'left_click_drag': {
          const [x2, y2] = (text ? (JSON.parse(text) as [number, number]) : coordinate) ?? [x, y]
          wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          wc.sendInputEvent({ type: 'mouseMove', x: x2, y: y2 })
          wc.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 })
          break
        }
        case 'scroll':
          wc.sendInputEvent({
            type: 'mouseWheel',
            x,
            y,
            deltaX: 0,
            deltaY: text === 'up' ? 300 : -300,
          } as unknown as Electron.MouseWheelInputEvent)
          break
        case 'type': {
          const sensitive = (await wc
            .executeJavaScript(`(${IS_SENSITIVE_FIELD_JS})(document.activeElement)`, true)
            .catch(() => false)) as boolean
          if (sensitive) return sensitiveFieldMessage('computer')
          for (const ch of text ?? '') {
            wc.sendInputEvent({ type: 'char', keyCode: ch } as Electron.KeyboardInputEvent)
          }
          break
        }
        case 'key': {
          const { keyCode, modifiers } = parseKeyCombo(text ?? '')
          if (keyCode.length === 0) break
          wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers } as Electron.KeyboardInputEvent)
          // Only a plain (or shifted) printable key produces text.
          if (keyCode.length === 1 && modifiers.every((m) => m === 'shift')) {
            wc.sendInputEvent({ type: 'char', keyCode, modifiers } as Electron.KeyboardInputEvent)
          }
          wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers } as Electron.KeyboardInputEvent)
          break
        }
      }
      // Let the page settle, then snapshot.
      await new Promise((r) => setTimeout(r, action === 'wait' ? 1500 : 400))
      this.pendingScreenshot = await this.screenshotDataUrl(win)
      const state = await win.webContents
        .executeJavaScript('({title: document.title, url: location.href})', true)
        .catch(() => ({ title: '', url: '' }))
      return `Action '${action}' done. Page: ${(state as { title: string }).title} (${(state as { url: string }).url}). A screenshot follows.`
    } catch (e) {
      return `Error performing '${action}': ${e instanceof Error ? e.message : String(e)}`
    }
  }

  close(): void {
    // A forced close (LRU eviction, quit) never leaves an agent waiting.
    this.returnControl()
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.pendingScreenshot = null
  }
}
