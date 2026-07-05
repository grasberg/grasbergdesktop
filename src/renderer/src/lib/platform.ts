/**
 * Canonical macOS detection for keyboard-shortcut labels.
 *
 * Some call sites used `navigator.platform.toLowerCase().includes('mac')`,
 * ShortcutsHelp additionally fell back to userAgent. In Electron (Chromium)
 * `navigator.platform` is always a non-empty string ('Win32', 'MacIntel',
 * 'Linux x86_64', ...), so the fallback never changes the result and both
 * detections agree on every platform we ship on; the defensive variant is
 * kept as the single canonical one.
 */
export const isMac = /mac/i.test(navigator.platform || navigator.userAgent)

/** Modifier-key word for tooltips/hints: 'Cmd' on macOS, 'Ctrl' elsewhere. */
export const modKeyLabel = isMac ? 'Cmd' : 'Ctrl'

/** Modifier-key symbol for the shortcuts dialog: '⌘' on macOS, 'Ctrl' elsewhere. */
export const modKeySymbol = isMac ? '⌘' : 'Ctrl'
