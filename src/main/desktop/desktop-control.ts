/**
 * Desktop control (v53): the `desktop` tool's engine — screenshots of the
 * primary display through Electron's desktopCapturer and mouse / keyboard
 * input through a long-lived PowerShell host calling user32 (Windows). This
 * drives the user's REAL computer, so:
 *
 * - it exists only while Settings → Tools → "Desktop control" is on (the
 *   registry hides the tool otherwise) and every call goes through the
 *   approval gate as a 'dangerous' outward tool;
 * - Ctrl+Alt+Escape is a global kill switch: it turns the setting off at
 *   once, ends the input host, and every later call is refused;
 * - the first action of a session raises a notification saying so.
 *
 * Other platforms get an honest "not supported here" — the browser tools
 * cover them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  comboToVirtualKeys,
  encodePowerShell,
  toScreenPoint,
  toSendKeysText,
  WINDOWS_INPUT_HOST,
  type InputCommand,
} from './input'

export const DESKTOP_KILL_SHORTCUT = 'CommandOrControl+Alt+Escape'
/** Screenshots handed to the model are this wide (aspect kept). */
const SHOT_WIDTH = 1280
const COMMAND_TIMEOUT_MS = 15_000

export interface DesktopDeps {
  platform: NodeJS.Platform
  /** Primary display in physical pixels. */
  primaryDisplay(): { x: number; y: number; width: number; height: number }
  /** PNG data URL of the primary display at the given size. */
  capture(size: { width: number; height: number }): Promise<string>
  isEnabled(): boolean
  disable(): void
  notify(title: string, body: string): void
  registerKillShortcut(onKill: () => void): void
  /** Test seam. */
  spawnHost?: () => ChildProcessWithoutNullStreams
}

export class DesktopControl {
  private host: ChildProcessWithoutNullStreams | null = null
  private lines: string[] = []
  private waiter: ((line: string) => void) | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private pendingScreenshot: string | null = null
  private announced = false
  private lastShot: { width: number; height: number } | null = null

  constructor(private readonly deps: DesktopDeps) {}

  consumePendingScreenshot(): string | null {
    const shot = this.pendingScreenshot
    this.pendingScreenshot = null
    return shot
  }

  /** The kill switch: off, host gone, nothing more runs until re-enabled. */
  kill(): void {
    this.deps.disable()
    this.stopHost()
    this.deps.notify('Desktop control stopped', 'Grasberg will not touch your mouse or keyboard until you turn it back on.')
  }

  stopHost(): void {
    this.host?.kill()
    this.host = null
    this.lines = []
    this.waiter = null
  }

  private shotSize(): { width: number; height: number } {
    const screen = this.deps.primaryDisplay()
    const width = Math.min(SHOT_WIDTH, screen.width)
    return { width, height: Math.round((screen.height * width) / screen.width) }
  }

  private async screenshot(): Promise<string> {
    const size = this.shotSize()
    this.lastShot = size
    const shot = await this.deps.capture(size)
    this.pendingScreenshot = shot
    return `Screenshot of your screen (${size.width}x${size.height}; coordinates refer to this image).`
  }

  private ensureHost(): void {
    if (this.host && this.host.exitCode === null) return
    const child =
      this.deps.spawnHost?.() ??
      spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(WINDOWS_INPUT_HOST)],
        { windowsHide: true }
      )
    this.host = child
    this.lines = []
    // PowerShell writes progress records to stderr; drain them so a full
    // pipe can never stall the host.
    child.stderr?.resume()
    const reader = createInterface({ input: child.stdout })
    reader.on('line', (line) => {
      const waiter = this.waiter
      if (waiter) {
        this.waiter = null
        waiter(line.trim())
      } else this.lines.push(line.trim())
    })
    child.on('exit', () => {
      if (this.host === child) this.host = null
      this.waiter?.('ERR the input host exited')
      this.waiter = null
    })
  }

  private nextLine(): Promise<string> {
    const queued = this.lines.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null
        // A late answer must never be read as the NEXT command's reply:
        // a host that missed its deadline is replaced.
        this.stopHost()
        resolve('ERR the input host did not answer')
      }, COMMAND_TIMEOUT_MS)
      this.waiter = (line) => {
        clearTimeout(timer)
        resolve(line)
      }
    })
  }

  private async send(command: InputCommand): Promise<string> {
    const run = async (): Promise<string> => {
      // Re-checked at the moment the command runs: a command queued before
      // Ctrl+Alt+Esc must not respawn the host and act after the kill.
      if (!this.deps.isEnabled()) return 'ERR desktop control was turned off'
      const fresh = !this.host || this.host.exitCode !== null
      this.ensureHost()
      if (fresh) {
        const ready = await this.nextLine()
        if (ready !== 'READY') return `ERR the input host failed to start (${ready})`
      }
      this.host!.stdin.write(`${JSON.stringify(command)}\n`)
      return this.nextLine()
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  private point(coordinate: [number, number] | undefined): [number, number] | null {
    if (!coordinate) return null
    return toScreenPoint(coordinate, this.lastShot ?? this.shotSize(), this.deps.primaryDisplay())
  }

  /** One desktop tool action. Always resolves to a model-readable string. */
  async run(action: string, coordinate?: [number, number], text?: string): Promise<string> {
    if (!this.deps.isEnabled()) return 'Desktop control is turned off in Settings → Tools.'
    if (this.deps.platform !== 'win32') {
      return 'Desktop control is only available on Windows. Use the browser tools instead.'
    }
    if (!this.announced) {
      this.announced = true
      this.deps.registerKillShortcut(() => this.kill())
      this.deps.notify(
        'Grasberg is controlling your desktop',
        'Press Ctrl+Alt+Esc at any time to stop it immediately.'
      )
    }
    if (action === 'screenshot') return this.screenshot()
    let command: InputCommand | null = null
    const at = this.point(coordinate)
    switch (action) {
      case 'mouse_move':
        if (at) command = { op: 'move', x: at[0], y: at[1] }
        break
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
        if (at) {
          command = {
            op: 'click',
            x: at[0],
            y: at[1],
            button: action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left',
            count: action === 'double_click' ? 2 : 1,
          }
        }
        break
      case 'left_click_drag': {
        let end: [number, number] | null = null
        try {
          const parsed = text ? (JSON.parse(text) as unknown) : null
          if (Array.isArray(parsed) && parsed.length === 2) end = this.point([Number(parsed[0]), Number(parsed[1])])
        } catch {
          end = null
        }
        if (at && end) command = { op: 'drag', x: at[0], y: at[1], x2: end[0], y2: end[1] }
        break
      }
      case 'scroll': {
        const where = at ?? this.point([Math.floor((this.lastShot ?? this.shotSize()).width / 2), Math.floor((this.lastShot ?? this.shotSize()).height / 2)])!
        command = { op: 'scroll', x: where[0], y: where[1], delta: text === 'up' ? 360 : -360 }
        break
      }
      case 'type':
        if (text) command = { op: 'keys', keys: toSendKeysText(text) }
        break
      case 'key': {
        const codes = comboToVirtualKeys(text ?? '')
        if (!codes) return `Error: unknown key combination "${text ?? ''}".`
        command = { op: 'vk', codes }
        break
      }
      case 'wait':
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return this.screenshot()
      default:
        return `Error: unknown desktop action '${action}'.`
    }
    if (!command) return `Error: '${action}' needs ${action === 'type' ? '"text"' : 'a "coordinate" [x, y] from the latest screenshot'}.`
    const answer = await this.send(command)
    if (answer.startsWith('ERR')) return `Error: ${answer.slice(4) || 'input failed'}`
    await new Promise((resolve) => setTimeout(resolve, 500))
    await this.screenshot()
    return `Desktop action '${action}' done. A screenshot follows.`
  }
}
