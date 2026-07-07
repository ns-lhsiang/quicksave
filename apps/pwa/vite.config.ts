// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { signalingServerPlugin } from './vite-plugin-relay';

// Prefer a locally-trusted mkcert certificate (installed as a CA profile on
// phones, so no per-visit "not private" warning) over vite's basicSsl plugin,
// which mints a throwaway self-signed cert every run — phones don't
// (reliably) remember trusting that across restarts. Falls back to basicSsl
// when the mkcert files aren't present (e.g. a fresh clone).
const certFile = process.env.QUICKSAVE_CERT_FILE || join(homedir(), '.local/share/quicksave-certs/quicksave.pem');
const keyFile = process.env.QUICKSAVE_KEY_FILE || join(homedir(), '.local/share/quicksave-certs/quicksave-key.pem');
const mkcertHttps = existsSync(certFile) && existsSync(keyFile)
  ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
  : null;

export default defineConfig({
  envPrefix: ['VITE_', 'QUICKSAVE_'],
  server: {
    host: true, // Allow external access (needed for ngrok)
    port: 5173,
    https: mkcertHttps || undefined,
    allowedHosts: ['.ngrok-free.app', '.ngrok.io', 'localhost'],
  },
  preview: {
    https: mkcertHttps || undefined,
  },
  plugins: [
    ...(mkcertHttps ? [] : [basicSsl()]),
    signalingServerPlugin(),
    react(),
    VitePWA({
      // `registerType: 'autoUpdate'` is a trap here: vite-plugin-pwa's
      // generated client code only auto-reloads on a new SW's `activated`
      // event, and NEVER sends the `SKIP_WAITING` message itself in that
      // mode — it assumes the generated SW calls `self.skipWaiting()`
      // unconditionally (true for `generateSW`). Our custom `sw.ts` only
      // calls `skipWaiting()` in response to an explicit `SKIP_WAITING`
      // message (see below), which is the `registerType: 'prompt'` contract:
      // that mode wires up `wb.addEventListener('waiting', ...)` to fire
      // `onNeedRefresh` and actually send the message. Mismatching the two
      // meant every new SW sat in `waiting` forever and no deploy ever
      // reached an already-open client until it was fully force-quit.
      registerType: 'prompt',
      // We register the SW ourselves in main.tsx via `virtual:pwa-register`
      // so `onNeedRefresh` above actually gets wired up — the default
      // injected `/registerSW.js` is a bare `navigator.serviceWorker.register()`
      // call with no update-detection logic at all.
      injectRegister: null,
      // Custom service worker so we can handle `push` / `notificationclick` events.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
      // Register the SW in `vite dev` too; otherwise navigator.serviceWorker.ready
      // hangs forever and the notification "Re-register" button looks stuck.
      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html',
      },
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
      manifest: {
        name: 'Quicksave',
        short_name: 'Quicksave',
        description: 'Remote git control with E2E encryption',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
        url_handlers: [
          { origin: process.env.QUICKSAVE_PWA_URL || 'http://localhost:5173' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  optimizeDeps: {
    include: ['quicksave-shared'],
  },
});
