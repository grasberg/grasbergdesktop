/**
 * Always-on lifecycle rules (v50), Electron-free so they stay unit-testable:
 * whether closing the window hides to the tray, whether a launch starts
 * hidden, what the OS login item should look like, and whether the process
 * may outlive its windows. Honesty rule: the app only ever claims to keep
 * running when there is a tray icon to come back through.
 */

export interface BackgroundInputs {
  runInBackground: boolean
  hasTray: boolean
  platform: NodeJS.Platform
}

/** Closing the window hides it (Windows/Linux, background mode, a tray exists, not quitting). */
export function shouldHideOnClose(input: BackgroundInputs & { quitting: boolean }): boolean {
  return (
    input.platform !== 'darwin' && input.runInBackground && input.hasTray && !input.quitting
  )
}

/** A login-item launch (or an explicit --hidden) starts in the tray when background mode is on. */
export function shouldStartHidden(input: {
  argv: readonly string[]
  wasOpenedAsHidden: boolean
  runInBackground: boolean
}): boolean {
  return input.runInBackground && (input.argv.includes('--hidden') || input.wasOpenedAsHidden)
}

/** The OS login item: start at login, hidden when the app is meant to live in the tray. */
export function loginItemSettings(input: { launchAtLogin: boolean; runInBackground: boolean }): {
  openAtLogin: boolean
  openAsHidden: boolean
  args: string[]
} {
  const hidden = input.launchAtLogin && input.runInBackground
  return { openAtLogin: input.launchAtLogin, openAsHidden: hidden, args: hidden ? ['--hidden'] : [] }
}

/** macOS already lives on without windows; elsewhere only with background mode AND a tray. */
export function keepAliveWithoutWindows(input: BackgroundInputs): boolean {
  return input.platform === 'darwin' || (input.runInBackground && input.hasTray)
}
