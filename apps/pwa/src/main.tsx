// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { IntlProvider } from './i18n/IntlProvider';
import './index.css';

// We no longer ship a service worker (removed 2026-07: its update lifecycle
// could strand an already-open tab on a stale bundle indefinitely — see
// git history on sw.ts). Actively unregister and clear any cache left by a
// previously-installed one so existing devices actually escape the trap
// instead of just not getting a new one.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
  });
}
if ('caches' in window) {
  void caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IntlProvider>
      <App />
    </IntlProvider>
  </React.StrictMode>
);
