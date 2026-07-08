// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
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
