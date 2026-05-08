// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import QRCode from 'qrcode';
import { Modal } from './ui/Modal';
import { ErrorBox } from './ui/ErrorBox';
import { Spinner } from './ui/Spinner';
import {
  PairClient,
  type PairInviteHandle,
  type Candidate,
} from '../lib/pairClient';
import { getDefaultPairTransport } from '../lib/pairTransport';
import { getMasterSecret } from '../lib/secureStorage';

interface PairDeviceModalProps {
  onClose: () => void;
}

type Phase = 'loading' | 'waiting' | 'submitting' | 'sent' | 'expired' | 'error';

export function PairDeviceModal({ onClose }: PairDeviceModalProps) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [candidateCount, setCandidateCount] = useState(0);
  const [sasInput, setSasInput] = useState('');
  const [sasFeedback, setSasFeedback] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [copied, setCopied] = useState(false);
  const [regenTick, setRegenTick] = useState(0);

  const inviteRef = useRef<PairInviteHandle | null>(null);
  const baseUrl = useMemo(
    () =>
      typeof window !== 'undefined'
        ? `${window.location.protocol}//${window.location.host}`
        : `${window.location.protocol}//${window.location.host}`,
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setPhase('loading');
        setError(null);
        setCandidateCount(0);
        setSasInput('');
        setSasFeedback(null);
        const masterSecret = await getMasterSecret();
        const transport = getDefaultPairTransport();
        const client = new PairClient(transport);
        const invite = await client.createInvite({
          baseUrl,
          masterSecret,
        });
        if (cancelled) {
          await invite.cancel();
          return;
        }
        inviteRef.current = invite;
        setPairUrl(invite.pairUrl);
        try {
          const dataUrl = await QRCode.toDataURL(invite.pairUrl, {
            width: 240,
            margin: 1,
            color: { dark: '#0f172a', light: '#ffffff' },
          });
          if (!cancelled) setQrDataUrl(dataUrl);
        } catch {
          // QR rendering failure is non-fatal — URL is still usable.
        }

        invite.onCandidate((_c: Candidate) => {
          setCandidateCount((n) => n + 1);
        });

        setPhase('waiting');
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      const invite = inviteRef.current;
      inviteRef.current = null;
      if (invite) void invite.cancel();
    };
  }, [baseUrl, regenTick]);

  useEffect(() => {
    const invite = inviteRef.current;
    if (!invite || phase !== 'waiting') return;
    const tick = () => {
      const remaining = Math.max(0, invite.expiresAt - Date.now());
      setRemainingMs(remaining);
      if (remaining === 0) {
        const expired = inviteRef.current;
        inviteRef.current = null;
        if (expired) void expired.cancel();
        setQrDataUrl('');
        setPairUrl('');
        setPhase('expired');
      }
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [phase]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pairUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const invite = inviteRef.current;
    if (!invite) return;
    setPhase('submitting');
    setSasFeedback(null);
    try {
      const result = await invite.submitSAS(sasInput);
      if (result.status === 'sent') {
        setPhase('sent');
      } else if (result.status === 'no-match') {
        setSasFeedback(intl.formatMessage({ id: 'pair.invite.sas.noMatch' }));
        setPhase('waiting');
      } else {
        setSasFeedback(intl.formatMessage({ id: 'pair.invite.sas.collision' }));
        setPhase('error');
        await invite.cancel();
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  return (
    <Modal
      title={intl.formatMessage({ id: 'pair.invite.title' })}
      onClose={onClose}
      maxWidth="max-w-lg"
      backdropClose={false}
    >
      <div className="p-4 space-y-4">
        {phase === 'loading' && (
          <div className="flex items-center gap-2 text-slate-400">
            <Spinner color="border-blue-500" /> <FormattedMessage id="pair.invite.loading" />
          </div>
        )}

        {phase === 'expired' && (
          <div className="space-y-3">
            <div className="p-3 bg-amber-500/15 border border-amber-500/40 rounded text-amber-200 text-sm">
              <FormattedMessage id="pair.invite.expired.message" />
            </div>
            <button
              type="button"
              onClick={() => setRegenTick((n) => n + 1)}
              className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 rounded-md font-medium"
            >
              <FormattedMessage id="pair.invite.expired.regenerate" />
            </button>
          </div>
        )}

        {phase !== 'loading' && phase !== 'error' && phase !== 'expired' && (
          <>
            <div className="flex flex-col items-center gap-3">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={intl.formatMessage({ id: 'pair.invite.qr.alt' })}
                  className="rounded bg-white p-2"
                />
              ) : (
                <div className="w-60 h-60 flex items-center justify-center bg-slate-700 rounded text-slate-500 text-sm">
                  <FormattedMessage id="pair.invite.qr.loading" />
                </div>
              )}
              <div className="w-full">
                <label className="block text-xs text-slate-400 mb-1">
                  <FormattedMessage id="pair.invite.copyHint" />
                </label>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={pairUrl}
                    className="flex-1 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded-md text-xs text-white font-mono truncate"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded-md"
                  >
                    <FormattedMessage id={copied ? 'pair.invite.copied' : 'pair.invite.copy'} />
                  </button>
                </div>
              </div>
              <div className="w-full text-xs text-slate-500 flex justify-between">
                <span>
                  <FormattedMessage
                    id="pair.invite.candidatesDetected"
                    values={{ count: candidateCount }}
                  />
                </span>
                <span>
                  <FormattedMessage
                    id="pair.invite.remaining"
                    values={{ seconds: Math.ceil(remainingMs / 1000) }}
                  />
                </span>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-2">
              <label className="block text-sm text-slate-300">
                <FormattedMessage id="pair.invite.sasPrompt" />
              </label>
              <input
                type="text"
                value={sasInput}
                onChange={(e) => setSasInput(e.target.value.toUpperCase())}
                maxLength={6}
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white text-center text-2xl font-mono tracking-widest placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={intl.formatMessage({ id: 'pair.invite.sasPlaceholder' })}
              />
              {sasFeedback && (
                <div className="text-sm text-amber-400">{sasFeedback}</div>
              )}
              <button
                type="submit"
                disabled={phase === 'submitting' || sasInput.length !== 6}
                className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium flex items-center justify-center gap-2"
              >
                {phase === 'submitting' && <Spinner />}
                <FormattedMessage
                  id={phase === 'submitting' ? 'pair.invite.submitting' : 'pair.invite.submit'}
                />
              </button>
            </form>
          </>
        )}

        {phase === 'sent' && (
          <div className="p-3 bg-emerald-500/20 border border-emerald-500/50 rounded text-emerald-300 text-sm">
            <FormattedMessage id="pair.invite.sent" />
          </div>
        )}

        {phase === 'error' && error && <ErrorBox>{error}</ErrorBox>}

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 rounded-md"
          >
            <FormattedMessage id={phase === 'sent' ? 'pair.invite.done' : 'pair.invite.cancel'} />
          </button>
        </div>
      </div>
    </Modal>
  );
}
