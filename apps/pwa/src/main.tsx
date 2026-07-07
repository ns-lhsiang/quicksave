// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { IntlProvider } from './i18n/IntlProvider';
import './index.css';

// `registerType: 'prompt'` (see vite.config.ts) requires the page to send
// `SKIP_WAITING` itself once a new SW is detected — this is what actually
// does that (immediately, no real prompt UI). Without it, updates silently
// sit in `waiting` until every client is fully closed.
if ('serviceWorker' in navigator) {
  const updateSW = registerSW({
    onNeedRefresh() {
      updateSW(true);
    },
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IntlProvider>
      <App />
    </IntlProvider>
  </React.StrictMode>
);
