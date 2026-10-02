/**
 * Desktop control, pure half (v53 — Muse "Mac computer work", dots "connect
 * your own computer"): key-name → virtual-key mapping, SendKeys escaping for
 * typed text, screenshot → screen coordinate scaling, and the PowerShell host
 * script that performs input on Windows through user32 (no native module —
 * the app stays free of native compilation).
 *
 * Electron-free so it is unit-tested in plain Node.
 */

/** Windows virtual-key codes for the key names a model uses. */
const VK: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  option: 0x12,
  win: 0x5b,
  cmd: 0x5b,
  meta: 0x5b,
  super: 0x5b,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  space: 0x20,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  page_up: 0x21,
  pagedown: 0x22,
  page_down: 0x22,
  printscreen: 0x2c,
  capslock: 0x14,
}

/** 'ctrl+shift+t' → [0x11, 0x10, 0x54]; null when a key is unknown. */
export function comboToVirtualKeys(combo: string): number[] | null {
  const keys: number[] = []
  for (const raw of combo.split('+')) {
    const name = raw.trim().toLowerCase()
    if (!name) continue
    if (VK[name] !== undefined) keys.push(VK[name])
    else if (/^f([1-9]|1[0-2])$/.test(name)) keys.push(0x70 + Number(name.slice(1)) - 1)
    else if (/^[a-z]$/.test(name)) keys.push(name.toUpperCase().charCodeAt(0))
    else if (/^[0-9]$/.test(name)) keys.push(name.charCodeAt(0))
    else return null
  }
  return keys.length > 0 ? keys : null
}

/** Escapes literal text for System.Windows.Forms.SendKeys. */
export function toSendKeysText(text: string): string {
  let out = ''
  for (const ch of text) {
    if (ch === '\n') out += '{ENTER}'
    else if (ch === '\r') continue
    else if (ch === '\t') out += '{TAB}'
    else if ('+^%~(){}[]'.includes(ch)) out += `{${ch}}`
    else out += ch
  }
  return out
}

/** Maps a point on the (downscaled) screenshot to physical screen pixels. */
export function toScreenPoint(
  point: [number, number],
  shot: { width: number; height: number },
  screen: { x: number; y: number; width: number; height: number }
): [number, number] {
  const [x, y] = point
  const clampedX = Math.min(Math.max(x, 0), shot.width - 1)
  const clampedY = Math.min(Math.max(y, 0), shot.height - 1)
  return [
    Math.round(screen.x + (clampedX * screen.width) / shot.width),
    Math.round(screen.y + (clampedY * screen.height) / shot.height),
  ]
}

/** One input command for the host (serialized as a JSON line). */
export type InputCommand =
  | { op: 'move'; x: number; y: number }
  | { op: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: number }
  | { op: 'drag'; x: number; y: number; x2: number; y2: number }
  | { op: 'scroll'; x: number; y: number; delta: number }
  | { op: 'keys'; keys: string }
  | { op: 'vk'; codes: number[] }
  | { op: 'cursor' }

/**
 * The long-lived PowerShell input host: defines the user32 bindings once,
 * becomes DPI-aware (so coordinates are physical pixels), then executes one
 * JSON command per stdin line and answers OK / ERR <message> / a value.
 */
export const WINDOWS_INPUT_HOST = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GrasbergInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[GrasbergInput]::SetProcessDPIAware() | Out-Null
$flags = @{ left = @(0x0002, 0x0004); right = @(0x0008, 0x0010); middle = @(0x0020, 0x0040) }
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $c = $line | ConvertFrom-Json
    $reply = 'OK'
    switch ($c.op) {
      'move' { [GrasbergInput]::SetCursorPos($c.x, $c.y) | Out-Null }
      'click' {
        [GrasbergInput]::SetCursorPos($c.x, $c.y) | Out-Null
        Start-Sleep -Milliseconds 40
        $pair = $flags[$c.button]
        for ($i = 0; $i -lt $c.count; $i++) {
          [GrasbergInput]::mouse_event($pair[0], 0, 0, 0, [UIntPtr]::Zero)
          [GrasbergInput]::mouse_event($pair[1], 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 60
        }
      }
      'drag' {
        [GrasbergInput]::SetCursorPos($c.x, $c.y) | Out-Null
        [GrasbergInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        [GrasbergInput]::SetCursorPos($c.x2, $c.y2) | Out-Null
        Start-Sleep -Milliseconds 80
        [GrasbergInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      }
      'scroll' {
        [GrasbergInput]::SetCursorPos($c.x, $c.y) | Out-Null
        [GrasbergInput]::mouse_event(0x0800, 0, 0, $c.delta, [UIntPtr]::Zero)
      }
      'keys' { [System.Windows.Forms.SendKeys]::SendWait($c.keys) }
      'vk' {
        foreach ($k in $c.codes) { [GrasbergInput]::keybd_event([byte]$k, 0, 0, [UIntPtr]::Zero) }
        [array]::Reverse($c.codes)
        foreach ($k in $c.codes) { [GrasbergInput]::keybd_event([byte]$k, 0, 2, [UIntPtr]::Zero) }
      }
      'cursor' {
        $p = [System.Windows.Forms.Cursor]::Position
        $reply = "POS $($p.X) $($p.Y)"
      }
    }
    [Console]::Out.WriteLine($reply)
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
}
`

/** The -EncodedCommand payload (UTF-16LE base64) for powershell.exe. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}
