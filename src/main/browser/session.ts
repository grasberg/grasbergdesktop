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

const VIEWPORT = { width: 1280, height: 800 }
const PARTITION = 'grasberg-browser' // non-persistent, isolated from the app
const NAV_TIMEOUT_MS = 20_000
const MAX_TEXT_CHARS = 6000
const MAX_ELEMENTS = 40
const SCREENSHOT_MAX_WIDTH = 1024

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

const SNAPSHOT_JS = `(() => {
  const pick = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    if (r.bottom < 0 || r.top > innerHeight) return null;
    const label = (el.getAttribute('aria-label') || el.value || el.placeholder || el.innerText || el.alt || '').trim().slice(0, 80);
    return { tag: el.tagName.toLowerCase(), label, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link]'));
  const elements = [];
  for (const n of nodes) { const p = pick(n); if (p && (p.label || p.tag === 'input')) elements.push(p); if (elements.length >= ${MAX_ELEMENTS}) break; }
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, ${MAX_TEXT_CHARS}), elements };
})()`

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

export class BrowserSession {
  private win: BrowserWindow | null = null
  private pendingScreenshot: string | null = null

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
    this.win = win
    return win
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
    const js = `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false; el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`
    let ok = false
    try {
      ok = (await this.win.webContents.executeJavaScript(js, true)) as boolean
    } catch {
      return `Error: could not type into "${selector}".`
    }
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
        case 'type':
          for (const ch of text ?? '') {
            wc.sendInputEvent({ type: 'char', keyCode: ch } as Electron.KeyboardInputEvent)
          }
          break
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
    if (this.win && !this.win.isDestroyed()) this.win.close()
    this.win = null
    this.pendingScreenshot = null
  }
}
