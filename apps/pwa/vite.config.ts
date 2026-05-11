// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { signalingServerPlugin } from './vite-plugin-relay';

export default defineConfig({
  envPrefix: ['VITE_', 'QUICKSAVE_'],
  server: {
    host: true, // Allow external access (needed for ngrok)
    port: 5173,
    allowedHosts: ['.ngrok-free.app', '.ngrok.io', 'localhost'],
  },
  plugins: [
    basicSsl(),
    signalingServerPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
