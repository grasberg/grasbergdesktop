import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = join(root, 'out', 'renderer')
const html = readFileSync(join(rendererDir, 'index.html'), 'utf8')
const match = /<script[^>]+src="\.\/([^"]+\.js)"/.exec(html)
if (!match) throw new Error('Could not find the renderer entry script in out/renderer/index.html.')

const entry = join(rendererDir, match[1])
const bytes = statSync(entry).size
const limit = 2_000_000
const kib = (bytes / 1024).toFixed(1)
if (bytes > limit) {
  throw new Error(`Renderer entry is ${kib} KiB; budget is ${(limit / 1024).toFixed(1)} KiB.`)
}
console.log(`BUNDLE_OK ${kib} KiB (${match[1]})`)
