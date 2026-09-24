import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const main = join(root, 'out', 'main', 'index.js')
await access(main)
// Every smoke run gets an empty profile; a check must never migrate or touch
// the user's conversations, paired devices, credentials or window state.
const smokeDir = await mkdtemp(join(tmpdir(), 'grasberg-smoke-'))
await writeFile(join(smokeDir, 'package.json'), JSON.stringify({ name: 'grasberg-smoke', version: '1.1.0', main: 'launch.cjs' }))
await writeFile(join(smokeDir, 'launch.cjs'), `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(join(smokeDir, 'profile'))}); app.setName('Grasberg smoke'); require(${JSON.stringify(main)});`)
let sawOk = false

const child = spawn(electron, [smokeDir], {
  cwd: root,
  env: { ...process.env, SMOKE_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
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

child.on('close', async (code) => {
  clearTimeout(timeout)
  if (code !== 0 || !sawOk) {
    console.error(`Smoke test failed (exit ${code ?? 'unknown'}, SMOKE_OK=${sawOk}).`)
    process.exitCode = 1
  }
  // smokeDir is the exact directory returned by mkdtemp above.
  await rm(smokeDir, { recursive: true, force: true, maxRetries: 3 }).catch(error => { console.error(`Could not clean the smoke profile: ${error.message}`); process.exitCode = 1 })
})
