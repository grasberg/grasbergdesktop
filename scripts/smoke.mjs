import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronCli = require.resolve('electron/cli.js')
let sawOk = false

const child = spawn(process.execPath, [electronCli, '.'], {
  cwd: root,
  env: { ...process.env, SMOKE_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const forward = (stream, target) => {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    if (chunk.includes('SMOKE_OK')) sawOk = true
    target.write(chunk)
  })
}
forward(child.stdout, process.stdout)
forward(child.stderr, process.stderr)

const timeout = setTimeout(() => {
  child.kill()
  console.error('Smoke test timed out before SMOKE_OK.')
  process.exitCode = 1
}, 30_000)

child.on('error', (error) => {
  clearTimeout(timeout)
  console.error(error)
  process.exitCode = 1
})

child.on('close', (code) => {
  clearTimeout(timeout)
  if (code !== 0 || !sawOk) {
    console.error(`Smoke test failed (exit ${code ?? 'unknown'}, SMOKE_OK=${sawOk}).`)
    process.exitCode = 1
  }
})
