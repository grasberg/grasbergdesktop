/**
 * Build config for the mobile web client (the phone half of remote access).
 *
 * A second, deliberately tiny vite root next to the desktop renderer: same
 * React/zustand/@shared contracts, none of the desktop app's weight. The
 * output lands in out/mobile and is served FROM THE DESKTOP through the relay
 * tunnel (src/main/remote/static.ts), so a phone always loads a UI version
 * matched to the main process it talks to.
 *
 * base './' matters: the bundle is served under /<desktopId>/ on the relay,
 * so asset URLs must be relative, not root-absolute.
 */

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    emptyOutDir: true,
    target: 'es2022',
  },
  // The desktop's electron-vite dev server owns 5173; keep out of its way.
  server: { port: 5178 },
})
