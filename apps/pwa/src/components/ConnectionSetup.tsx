// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import { ErrorBox } from './ui/ErrorBox';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { QRScanner } from './QRScanner';

interface Props {
  onConnect: (agentId: string, publicKey: string) => void;
}

export function ConnectionSetup({ onConnect }: Props) {
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const { state, error } = useConnectionStore();
  const { addMachine } = useMachineStore();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (agentId.trim() && publicKey.trim()) {
      // Save machine before connecting
      addMachine({
        agentId: agentId.trim(),
        publicKey: publicKey.trim(),
        nickname: `Machine ${agentId.trim().slice(0, 8)}`,
        icon: '',
      });
      onConnect(agentId.trim(), publicKey.trim());
    }
  };

  const isConnecting = state === 'connecting';

  return (
    <div className="h-full overflow-y-auto flex flex-col items-center p-4 safe-area-top safe-area-bottom">
      <div className="w-full max-w-md my-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white">Quicksave</h1>
            <p className="text-xs text-slate-400">Remote git control with E2E encryption</p>
          </div>
          <button
            onClick={() => navigate('/settings')}
            className="p-2 text-slate-400 hover:text-white transition-colors"
            aria-label="Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>

        {/* Connection Form */}
        <div className="bg-slate-800 rounded-lg p-4">
          <h2 className="text-base font-semibold mb-3"><FormattedMessage id="connectionSetup.title" /></h2>

          {/* Mode Toggle */}
          <div className="flex mb-4 bg-slate-700 rounded-lg p-1">
            <button
              type="button"
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                mode === 'scan'
                  ? 'bg-slate-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              onClick={() => setMode('scan')}
            >
              Scan QR
            </button>
            <button
              type="button"
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                mode === 'manual'
                  ? 'bg-slate-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              onClick={() => setMode('manual')}
            >
              Manual Entry
            </button>
          </div>

          {mode === 'manual' ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="agentId" className="block text-sm font-medium text-slate-300 mb-1">
                  Agent ID
                </label>
                <input
                  id="agentId"
                  type="text"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  placeholder="Enter agent ID"
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={isConnecting}
                />
              </div>

              <div>
                <label htmlFor="publicKey" className="block text-sm font-medium text-slate-300 mb-1">
                  Public Key
                </label>
                <textarea
                  id="publicKey"
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  placeholder="Enter agent public key"
                  rows={3}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono text-sm"
                  disabled={isConnecting}
                />
              </div>

              {error && (
                <ErrorBox className="p-3">{error}</ErrorBox>
              )}

              <button
                type="submit"
                disabled={!agentId.trim() || !publicKey.trim() || isConnecting}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors"
              >
                {isConnecting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                    <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                    <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                  </span>
                ) : (
                  'Connect'
                )}
              </button>
            </form>
          ) : (
            <div className="py-4">
              <QRScanner
                onScan={(id, pk, _name, spk) => {
                  // Save machine and connect
                  addMachine({
                    agentId: id,
                    publicKey: pk,
                    signPublicKey: spk,
                    nickname: `Machine ${id.slice(0, 8)}`,
                    icon: '',
                  });
                  onConnect(id, pk);
                }}
              />
              {error && (
                <ErrorBox className="mt-4 p-3">{error}</ErrorBox>
              )}
            </div>
          )}
        </div>

        {/* Help Text */}
        <div className="mt-4 text-center">
          <p className="text-xs text-slate-500">
            Run <code className="text-slate-400">quicksave</code> on your computer to get connection details.
          </p>
        </div>
      </div>

    </div>
  );
}
