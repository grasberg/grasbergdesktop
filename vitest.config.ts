import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // These suites hit real temp SQLite databases and the real filesystem, and
    // node-sqlite3-wasm is synchronous — a migration test blocks its worker
    // thread for the whole rebuild (+ VACUUM INTO snapshots). Alone such a test
    // takes ~0.6s, but with one worker per core all doing that at once it can
    // stretch past vitest's silent 5s default and be killed mid-flight, which
    // showed up as a rare (~7%) flake in the FK-safe rebuild tests. The budget
    // below is a harness allowance, not a performance assertion; a genuine
    // deadlock still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Cap worker threads. node-sqlite3-wasm blocks its worker thread
    // synchronously through a whole migration/VACUUM, and one busy worker per
    // core (24 on a workstation) starves vitest's worker→main progress RPC,
    // surfacing as a nondeterministic "Timeout calling onTaskUpdate" that can
    // flip the run's exit code even though every test passed. A modest ceiling
    // gives each worker enough CPU to stay responsive; lower-core CI runners
    // are under this cap already, so they are unaffected.
    maxWorkers: 4,
    minWorkers: 1,
  },
})
