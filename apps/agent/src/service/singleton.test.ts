// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { isProcessAlive } from './singleton.js';
import { shouldRestartDaemon, IPC_VERSION, BUILD_ID, isDev } from './types.js';
import type { HelloResult } from './types.js';

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 99999999 is extremely unlikely to exist
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

describe('shouldRestartDaemon', () => {
  const makeDaemon = (overrides: Partial<HelloResult> = {}): HelloResult => ({
    daemonVersion: '0.8.7',
    daemonIpcVersion: IPC_VERSION,
    daemonBuildId: BUILD_ID,
    daemonPid: 12345,
    ...overrides,
  });

  it('returns ok when versions match', () => {
    const result = shouldRestartDaemon(
      makeDaemon(),
      { ipcVersion: IPC_VERSION, buildId: BUILD_ID },
    );
    expect(result.action).toBe('ok');
  });

  it('returns restart when daemon ipcVersion is lower', () => {
    const result = shouldRestartDaemon(
      makeDaemon({ daemonIpcVersion: 0 }),
      { ipcVersion: IPC_VERSION, buildId: BUILD_ID },
    );
    expect(result.action).toBe('restart');
  });

  it('returns warn_outdated when CLI ipcVersion is lower', () => {
    const result = shouldRestartDaemon(
      makeDaemon({ daemonIpcVersion: 99 }),
      { ipcVersion: IPC_VERSION, buildId: BUILD_ID },
    );
    expect(result.action).toBe('warn_outdated');
  });

  it('returns restart when buildId differs (dev)', () => {
    const result = shouldRestartDaemon(
      makeDaemon({ daemonBuildId: 'dev-aaa111bbb222' }),
      { ipcVersion: IPC_VERSION, buildId: 'dev-ccc333ddd444' },
    );
    expect(result.action).toBe('restart');
  });

  it('returns restart when buildId differs with prod-style stamped hashes', () => {
    // Simulates `npm install -g quicksave@newer` replacing an older daemon:
    // both sides carry stamped prod hashes, not dev- prefixed.
    const result = shouldRestartDaemon(
      makeDaemon({ daemonBuildId: 'a1b2c3d4e5f6' }),
      { ipcVersion: IPC_VERSION, buildId: 'f6e5d4c3b2a1' },
    );
    expect(result.action).toBe('restart');
  });
});

describe('isDev', () => {
  it('returns true when globalThis.__QUICKSAVE_DEV__ is set', () => {
    // vitest.setup.ts sets this before test modules load
    expect((globalThis as { __QUICKSAVE_DEV__?: boolean }).__QUICKSAVE_DEV__).toBe(true);
    expect(isDev()).toBe(true);
  });

  it('BUILD_ID starts with "dev-" under the injected global', () => {
    expect(BUILD_ID.startsWith('dev-')).toBe(true);
  });
});
