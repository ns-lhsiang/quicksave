// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormattedMessage, useIntl } from 'react-intl';
import { useGitStore } from '../stores/gitStore';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { PairDeviceModal } from './PairDeviceModal';
import { ScanToJoinModal } from './ScanToJoinModal';
import { ApiKeySection } from './settings/ApiKeySection';
import { DangerZoneSection } from './settings/DangerZoneSection';
import { MachinesSection } from './settings/MachinesSection';
import { LanguageSection } from './settings/LanguageSection';

interface SettingsPageProps {
  onSendApiKeyToAgent?: (apiKey: string) => Promise<boolean>;
}

export function SettingsPage({ onSendApiKeyToAgent }: SettingsPageProps) {
  const navigate = useNavigate();
  const intl = useIntl();
  const [showPairModal, setShowPairModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={
          <span className="text-sm font-medium text-slate-300">
            {intl.formatMessage({ id: 'settings.title' })}
          </span>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-6">
          <MachinesSection />

          <div className="border-t border-slate-700" />

          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              <FormattedMessage id="settings.deviceSync.title" />
            </h3>

            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowPairModal(true)}
                className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 rounded-md font-medium"
              >
                <FormattedMessage id="settings.deviceSync.invite.button" />
              </button>
              <p className="text-xs text-slate-500">
                <FormattedMessage id="settings.deviceSync.invite.description" />
              </p>
            </div>

            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowScanModal(true)}
                className="w-full py-2 px-4 bg-slate-700 hover:bg-slate-600 rounded-md font-medium"
              >
                <FormattedMessage id="settings.deviceSync.join.button" />
              </button>
              <p className="text-xs text-slate-500">
                <FormattedMessage id="settings.deviceSync.join.description" />
              </p>
            </div>
          </div>

          <div className="border-t border-slate-700" />

          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              <FormattedMessage id="settings.git.title" />
            </h3>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="text-sm text-white">
                  <FormattedMessage id="settings.git.commitAttribution.label" />
                </span>
                <p className="text-xs text-slate-400 mt-0.5">
                  <FormattedMessage id="settings.git.commitAttribution.description" />
                </p>
              </div>
              <AttributionToggle />
            </label>
          </div>

          <div className="border-t border-slate-700" />

          <ApiKeySection isOpen onSendApiKeyToAgent={onSendApiKeyToAgent} />

          <div className="border-t border-slate-700" />

          <LanguageSection />

          <div className="border-t border-slate-700" />

          <DangerZoneSection />

        </div>
      </div>
      {showPairModal && (
        <PairDeviceModal onClose={() => setShowPairModal(false)} />
      )}
      {showScanModal && (
        <ScanToJoinModal onClose={() => setShowScanModal(false)} />
      )}
    </div>
  );
}

function AttributionToggle() {
  const enabled = useGitStore((s) => s.attributionEnabled);
  const setEnabled = useGitStore((s) => s.setAttributionEnabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => setEnabled(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 ease-in-out ${enabled ? 'bg-purple-600' : 'bg-slate-600'}`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out mt-0.5 ${enabled ? 'translate-x-5 ml-0.5' : 'translate-x-0 ml-0.5'}`} />
    </button>
  );
}
