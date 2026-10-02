const { spawn } = require('node:child_process')
const { access } = require('node:fs/promises')
const { join, resolve } = require('node:path')

// electron-builder calls this for the app, NSIS uninstaller and final installer.
// The Office script owns the Azure profile, authentication and SignTool verify.
module.exports = async function signWindows({ path: file, hash }) {
  if (process.platform !== 'win32') throw new Error('Windows signing requires Windows.')
  if (hash !== 'sha256') throw new Error('Azure Artifact Signing requires SHA-256.')

  const signingDirectory = process.env.GRASBERG_OFFICE_SIGNING_DIR
  if (!signingDirectory) {
    throw new Error('Set GRASBERG_OFFICE_SIGNING_DIR to Grasberg Office\'s signing directory.')
  }
  await access(resolve(signingDirectory, 'Invoke-GrasbergSigning.ps1'))
  const script = join(__dirname, 'sign-windows.ps1')
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  await new Promise((resolveSigning, reject) => {
    const child = spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-LiteralPath', file
    ], { stdio: 'inherit', windowsHide: true, shell: false })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolveSigning()
      else reject(new Error(`Azure signing or signature verification failed for ${file} (exit ${code}).`))
    })
  })
}
