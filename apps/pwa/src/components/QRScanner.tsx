// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState, useCallback } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Html5Qrcode } from 'html5-qrcode';
import { Spinner } from './ui/Spinner';

interface QRScannerProps {
  onScan: (agentId: string, publicKey: string, name?: string, signPublicKey?: string) => void;
  onPairingScan?: (publicKey: string) => void;
  onError?: (error: string) => void;
}

export function QRScanner({ onScan, onPairingScan, onError }: QRScannerProps) {
  const intl = useIntl();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [shouldStart, setShouldStart] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const handleScan = useCallback((decodedText: string) => {
    const stopAndCall = (fn: () => void) => {
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(console.error);
      }
      setIsScanning(false);
      setShouldStart(false);
      fn();
    };

    try {
      const url = new URL(decodedText);

      // Agent URL format: http://localhost:5173/#/connect/{agentId}?pk={key}&spk={signKey}&name={name}
      const hash = url.hash; // e.g. "#/connect/abc123?pk=xyz&spk=abc&name=MyPC"
      const connectMatch = hash.match(/^#\/connect\/([^?]+)\??(.*)/);
      if (connectMatch) {
        const agentId = connectMatch[1];
        const hashParams = new URLSearchParams(connectMatch[2]);
        const pk = hashParams.get('pk');
        if (agentId && pk) {
          const name = hashParams.get('name') || undefined;
          const spk = hashParams.get('spk') || undefined;
          stopAndCall(() => onScan(agentId, pk, name, spk));
          return;
        }
      }

      // Legacy format: ?id={agentId}&pk={key}
      const id = url.searchParams.get('id');
      const pk = url.searchParams.get('pk');
      if (id && pk) {
        const name = url.searchParams.get('name') || undefined;
        const spk = url.searchParams.get('spk') || undefined;
        stopAndCall(() => onScan(id, pk, name, spk));
        return;
      }

      // Pairing format: ?pair=PUBLIC_KEY
      const pairKey = url.searchParams.get('pair');
      if (pairKey && onPairingScan) {
        stopAndCall(() => onPairingScan(pairKey));
        return;
      }

      setError(intl.formatMessage({ id: 'qrScanner.error.invalid' }));
    } catch {
      setError(intl.formatMessage({ id: 'qrScanner.error.invalidFormat' }));
    }
  }, [onScan, onPairingScan, intl]);

  // Start scanner when shouldStart becomes true and element is mounted
  useEffect(() => {
    if (!shouldStart) return;

    const scannerId = 'qr-scanner';
    const element = document.getElementById(scannerId);
    if (!element) return;

    const startScanner = async () => {
      setIsStarting(true);
      setError(null);
      setPermissionDenied(false);

      try {
        scannerRef.current = new Html5Qrcode(scannerId);

        await scannerRef.current.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
          },
          (decodedText) => {
            handleScan(decodedText);
          },
          () => {
            // QR code not found - ignore
          }
        );

        setIsScanning(true);
        setError(null);
      } catch (err) {
        console.error('Failed to start scanner:', err);
        const message = err instanceof Error ? err.message : intl.formatMessage({ id: 'qrScanner.fallback.cameraAccess' });
        setError(message);
        setPermissionDenied(true);
        setShouldStart(false);
        onError?.(message);
      } finally {
        setIsStarting(false);
      }
    };

    startScanner();
  }, [shouldStart, handleScan, onError, intl]);

  const stopScanner = useCallback(async () => {
    if (scannerRef.current?.isScanning) {
      await scannerRef.current.stop().catch(console.error);
    }
    setIsScanning(false);
    setShouldStart(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(console.error);
      }
    };
  }, []);

  const showStartButton = !shouldStart && !isScanning;

  return (
    <div className="text-center">
      {/* Scanner area */}
      <div className="relative w-full max-w-[250px] mx-auto mb-3">
        {/* Placeholder shown when not scanning */}
        {showStartButton && (
          <div className="w-full aspect-square bg-slate-700 rounded-lg flex items-center justify-center">
            <svg
              className="w-16 h-16 text-slate-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
              />
            </svg>
          </div>
        )}

        {/* Scanner container - rendered when starting/scanning */}
        {(shouldStart || isScanning) && (
          <>
            {/* Loading overlay */}
            {isStarting && (
              <div className="absolute inset-0 bg-slate-700 rounded-lg flex items-center justify-center z-10">
                <Spinner size="w-12 h-12" color="border-blue-500" />
              </div>
            )}

            {/* The actual scanner element - kept empty for html5-qrcode */}
            <div
              id="qr-scanner"
              className="w-full aspect-square bg-slate-700 rounded-lg overflow-hidden"
            />

            {/* Scanning indicator overlay */}
            {isScanning && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-4 border-2 border-blue-500 rounded-lg">
                  <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-blue-400 rounded-tl" />
                  <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-blue-400 rounded-tr" />
                  <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-blue-400 rounded-bl" />
                  <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-blue-400 rounded-br" />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Status messages */}
      {showStartButton && (
        permissionDenied ? (
          <>
            <p className="text-red-400 text-sm mb-2">
              <FormattedMessage id="qrScanner.error.permissionDenied" />
            </p>
            <p className="text-slate-400 text-xs mb-4">
              <FormattedMessage id="qrScanner.error.permissionHint" />
            </p>
          </>
        ) : error ? (
          <p className="text-yellow-400 text-sm mb-4">{error}</p>
        ) : (
          <p className="text-slate-400 text-sm mb-4">
            <FormattedMessage id="qrScanner.prompt.tapToScan" />
          </p>
        )
      )}

      {isStarting && (
        <p className="text-slate-400 text-sm mb-4">
          <FormattedMessage id="qrScanner.starting" />
        </p>
      )}

      {isScanning && !error && (
        <p className="text-slate-400 text-sm mb-4">
          <FormattedMessage id="qrScanner.prompt.scanning" />
        </p>
      )}

      {isScanning && error && (
        <p className="text-yellow-400 text-sm mb-4">{error}</p>
      )}

      {/* Action buttons */}
      {showStartButton && (
        <button
          onClick={() => setShouldStart(true)}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium text-white transition-colors"
        >
          <FormattedMessage id={permissionDenied ? 'qrScanner.button.tryAgain' : 'qrScanner.button.startCamera'} />
        </button>
      )}

      {isScanning && (
        <button
          onClick={stopScanner}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg text-sm text-white transition-colors"
        >
          <FormattedMessage id="qrScanner.button.stopCamera" />
        </button>
      )}
    </div>
  );
}
