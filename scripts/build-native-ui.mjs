import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'out', 'mobile')
const destination = join(root, 'mobile_flutter', 'assets', 'ui')
// Only our generated bundle directory is replaced; never a computed user path.
if (relative(root, destination).replaceAll('\\', '/') !== 'mobile_flutter/assets/ui') throw new Error('Unexpected asset destination')
await readdir(source) // A missing build must not erase the last packaged UI.
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true })
console.log('Packaged shared UI in mobile_flutter/assets/ui')
