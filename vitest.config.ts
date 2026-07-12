import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
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
  },
})
