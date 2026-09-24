/**
 * Build config for the mobile web client (the phone half of remote access).
 *
 * A second, deliberately tiny vite root next to the desktop renderer: same
 * React/zustand/@shared contracts, none of the desktop app's weight. The
 * output lands in out/mobile and must be deployed to a trusted static origin
 * that is separate from the untrusted relay. The client receives the relay
 * and desktop routing values in the QR fragment.
 *
 * base './' keeps the bundle deployable below an arbitrary static path.
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
      '@': resolve(__dirname, 'src/renderer/src'),
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
