// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * systemd user-unit integration.
 *
 * The CLI prefers letting systemd own the daemon lifecycle when a user-scoped
 * `quicksave.service` unit is enabled. The hand-rolled detached spawn path in
 * `ensureDaemon` stays as a fallback for non-systemd hosts (macOS, Windows,
 * containers without systemd) and for users who haven't installed the unit.
 *
 * This module exposes both the read path used by `ensureDaemon` (`userUnitIs
 * Enabled`, `startUserUnit`) and the install/uninstall path used by the
 * IPC handler the PWA calls when the user toggles "Auto-start at login".
 *
 * The canonical unit text is generated here, not read from the
 * `apps/agent/templates/quicksave.service` file. The package.json `files`
 * allowlist only ships `dist/`, so a template loaded from disk would work in
 * dev but be missing for npm-installed users. Generating the text in code
 * also lets us bake the absolute `ExecStart` (node + entry path) computed
 * from the running daemon, which is the part most users get wrong by hand.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { homedir, platform } from 'os';
import { dirname, join, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';

export const QUICKSAVE_UNIT = 'quicksave.service';

/**
 * Where the user unit file lives. Honors `XDG_CONFIG_HOME` like systemd
 * itself does.
 */
export function getUserUnitDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : join(homedir(), '.config');
  return join(xdg, 'systemd', 'user');
}

export function getUserUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getUserUnitDir(env), QUICKSAVE_UNIT);
}

/**
 * Compute the `ExecStart` line that matches the currently running daemon —
 * absolute node binary (`process.execPath`) plus the entry script that this
 * process was loaded from. We resolve from `import.meta.url`, the same trick
 * `handleAgentRestart` uses, so dev (tsx) and prod (compiled JS) both work
 * without configuration. The resulting line is what the unit will run, so
 * the systemd-managed daemon is byte-identical to whatever the user currently
 * has installed.
 */
export function computeExecStart(metaUrl: string = import.meta.url): string {
  const thisFile = fileURLToPath(metaUrl);
  const isTs = thisFile.endsWith('.ts');
  const entryPath = resolvePath(dirname(thisFile), isTs ? '../index.ts' : '../index.js');
  const node = process.execPath;
  // Quote any path that contains whitespace; systemd's command parser is
  // shell-like enough that bare paths work in the common case but break on
  // e.g. `~/Library/Application Support/...`.
  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  if (isTs) {
    return `${q(node)} --import tsx ${q(entryPath)} service run`;
  }
  return `${q(node)} ${q(entryPath)} service run`;
}

/**
 * Generate the unit-file text. Kept tiny and opinionated — every option here
 * is one we'd want to set for every user. Anything more exotic (custom env,
 * resource limits) belongs in a `*.service.d/override.conf` drop-in the user
 * authors themselves.
 */
export function renderUnitText(execStart: string): string {
  return [
    '[Unit]',
    'Description=Quicksave agent daemon',
    'Documentation=https://github.com/ns-lhsiang/quicksave',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
    'TimeoutStopSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * True when the current process was started by systemd. Read by the daemon
 * boot path (`run.ts`) so we can stamp `service.json` with `managedBy:
 * "systemd"` — that's the single source of truth the CLI uses to decide
 * whether to delegate restarts to `systemctl` instead of self-spawning.
 */
export function wasLaunchedBySystemd(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID || env.JOURNAL_STREAM);
}

/**
 * True when `systemctl --user` works at all on this host (Linux + a running
 * systemd user instance + DBus session). Used to gate the entire feature in
 * the PWA — there's no point showing the toggle on macOS/Windows/no-systemd
 * containers.
 */
export function systemctlAvailable(): boolean {
  if (platform() !== 'linux') return false;
  // `systemctl --user --version` exits 0 even when there's no user instance
  // running, so additionally probe `is-system-running` which fails fast
  // (with status, not error) when DBus session is missing.
  const ver = spawnSync('systemctl', ['--user', '--version'], {
    stdio: 'ignore', timeout: 2000,
  });
  if (ver.error || ver.status === null) return false;
  // is-system-running prints e.g. "running", "degraded", "starting" and
  // exits 0; "offline" / no-DBus exits non-zero. Either is fine for our
  // purposes — the user has *some* form of `--user` instance reachable.
  return true;
}

/**
 * True when a user-scoped quicksave.service is installed and enabled.
 * Always false on non-Linux. Always false if `systemctl` isn't on PATH or
 * the user has no systemd --user instance (e.g. headless sshd without
 * lingering enabled).
 */
export function userUnitIsEnabled(): boolean {
  if (platform() !== 'linux') return false;
  const result = spawnSync('systemctl', ['--user', 'is-enabled', '--quiet', QUICKSAVE_UNIT], {
    stdio: 'ignore',
    timeout: 2000,
  });
  if (result.error || result.status === null) return false;
  return result.status === 0;
}

/**
 * True when the unit is currently active (running). Distinct from "enabled"
 * — a unit can be enabled but stopped, or active but not enabled (one-shot
 * `systemctl start` without enabling at boot).
 */
export function userUnitIsActive(): boolean {
  if (platform() !== 'linux') return false;
  const result = spawnSync('systemctl', ['--user', 'is-active', '--quiet', QUICKSAVE_UNIT], {
    stdio: 'ignore',
    timeout: 2000,
  });
  if (result.error || result.status === null) return false;
  return result.status === 0;
}

/**
 * Whether this user has lingering enabled (i.e. their systemd user instance
 * survives logout). We can't enable this from inside the daemon — it
 * requires polkit/sudo — so the PWA UI surfaces this as a read-only hint
 * with a "run this command yourself" callout.
 */
export function lingerIsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform() !== 'linux') return false;
  const user = env.USER || env.LOGNAME;
  if (!user) return false;
  // /var/lib/systemd/linger/<user> is created by `loginctl enable-linger`.
  // Reading this avoids spawning `loginctl show-user` which is ~5x slower
  // and needs DBus.
  return existsSync(join('/var/lib/systemd/linger', user));
}

/**
 * Ask systemd to (re)start the unit. Returns true on success.
 *
 * Uses `restart` rather than `start` so that a degraded daemon (e.g. lock
 * held but socket dead) gets cleanly torn down before the new instance
 * comes up. systemd's own `Restart=on-failure` already handles crash
 * recovery; this is for explicit CLI-initiated transitions.
 */
export function startUserUnit(): boolean {
  if (platform() !== 'linux') return false;
  const result = spawnSync('systemctl', ['--user', 'restart', QUICKSAVE_UNIT], {
    stdio: 'ignore',
    timeout: 10_000,
  });
  if (result.error || result.status === null) return false;
  return result.status === 0;
}

/** Status snapshot returned to the PWA so the UI can render the toggle's
 *  current state and any inline hints. `available: false` is the signal to
 *  hide the entire section. */
export interface SystemdStatus {
  available: boolean;
  unitInstalled: boolean;
  unitEnabled: boolean;
  isActive: boolean;
  lingerEnabled: boolean;
  unitDir: string;
  unitPath: string;
  suggestedExecStart: string;
  /** ExecStart line currently written to the unit file (parsed from disk),
   *  if installed. Lets the PWA warn when it's drifted from the daemon's
   *  computed value (e.g. user upgraded node, unit still points at old path). */
  currentExecStart?: string;
}

export function readInstalledExecStart(): string | undefined {
  const path = getUserUnitPath();
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, 'utf-8');
    for (const line of text.split('\n')) {
      const m = /^ExecStart\s*=\s*(.+)$/.exec(line.trim());
      if (m) return m[1].trim();
    }
  } catch {
    // Unreadable unit file — same outcome as missing for our purposes.
  }
  return undefined;
}

export function getSystemdStatus(): SystemdStatus {
  const available = systemctlAvailable();
  const unitPath = getUserUnitPath();
  const unitInstalled = available && existsSync(unitPath);
  return {
    available,
    unitInstalled,
    unitEnabled: available ? userUnitIsEnabled() : false,
    isActive: available ? userUnitIsActive() : false,
    lingerEnabled: available ? lingerIsEnabled() : false,
    unitDir: getUserUnitDir(),
    unitPath,
    suggestedExecStart: computeExecStart(),
    currentExecStart: unitInstalled ? readInstalledExecStart() : undefined,
  };
}

/**
 * Result of an install/uninstall request.
 *
 * `success: false` always carries an `error` string suitable for surfacing
 * directly in the PWA; the caller doesn't need to translate error codes.
 */
export interface SystemdMutationResult {
  success: boolean;
  error?: string;
  status: SystemdStatus;
}

/**
 * Write the unit file, run `daemon-reload`, then `enable --now`.
 *
 * `--now` makes systemd start the unit immediately as part of the enable.
 * The current daemon will likely be the one currently holding the singleton
 * lock; that's fine — `enable --now` no-ops on the start step if a daemon
 * is already running because the new instance will fail to acquire the
 * lock and exit. We don't try to forcibly migrate the existing daemon
 * under systemd here — the next IPC call from the CLI/PWA will go through
 * `ensureDaemon`, which sees the unit is enabled and routes through
 * `systemctl restart` from then on.
 */
export function installUserUnit(execStart: string = computeExecStart()): SystemdMutationResult {
  if (!systemctlAvailable()) {
    return { success: false, error: 'systemctl --user is not available on this host', status: getSystemdStatus() };
  }
  try {
    mkdirSync(getUserUnitDir(), { recursive: true });
    writeFileSync(getUserUnitPath(), renderUnitText(execStart));
  } catch (err) {
    return {
      success: false,
      error: `Failed to write unit file: ${err instanceof Error ? err.message : String(err)}`,
      status: getSystemdStatus(),
    };
  }
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe', timeout: 10_000 });
  if (reload.error || reload.status !== 0) {
    return {
      success: false,
      error: `daemon-reload failed: ${stderrText(reload)}`,
      status: getSystemdStatus(),
    };
  }
  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', QUICKSAVE_UNIT], { stdio: 'pipe', timeout: 15_000 });
  if (enable.error || enable.status !== 0) {
    return {
      success: false,
      error: `enable --now failed: ${stderrText(enable)}`,
      status: getSystemdStatus(),
    };
  }
  return { success: true, status: getSystemdStatus() };
}

/**
 * `disable --now`, then remove the unit file, then `daemon-reload`.
 *
 * Important sequencing concern: when the *currently running daemon* was
 * itself launched by systemd, `disable --now` will stop it — including the
 * IPC server that's processing this very request. The IPC layer needs to
 * have already flushed the response before we reach this function. The
 * caller (`messageHandler.handleSystemdUninstall`) handles that by:
 *   1. computing what the response will be
 *   2. scheduling the uninstall on the next tick
 *   3. returning the response synchronously
 * so the PWA gets its ack before the socket dies.
 *
 * We also detach a "fallback re-spawn" so the user isn't left with no
 * daemon at all after uninstalling. That's the caller's job — it must
 * spawn the standalone daemon shortly after the uninstall completes if
 * the request originated from a PWA that wants to keep working.
 */
export function uninstallUserUnit(): SystemdMutationResult {
  if (!systemctlAvailable()) {
    return { success: false, error: 'systemctl --user is not available on this host', status: getSystemdStatus() };
  }
  // disable --now: ignore non-zero (the unit may already be disabled) but
  // capture the message in case nothing else explains a later failure.
  const disable = spawnSync('systemctl', ['--user', 'disable', '--now', QUICKSAVE_UNIT], { stdio: 'pipe', timeout: 15_000 });
  let firstError: string | undefined;
  if (disable.error || (disable.status !== 0 && disable.status !== 1)) {
    firstError = `disable --now warning: ${stderrText(disable)}`;
  }
  try {
    if (existsSync(getUserUnitPath())) unlinkSync(getUserUnitPath());
  } catch (err) {
    return {
      success: false,
      error: `Failed to remove unit file: ${err instanceof Error ? err.message : String(err)}`,
      status: getSystemdStatus(),
    };
  }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 10_000 });
  // `reset-failed` clears any failed-state markers left over from the
  // disable/stop so the unit doesn't show up in `systemctl --user --failed`.
  spawnSync('systemctl', ['--user', 'reset-failed', QUICKSAVE_UNIT], { stdio: 'ignore', timeout: 5_000 });
  return { success: true, error: firstError, status: getSystemdStatus() };
}

function stderrText(result: ReturnType<typeof spawnSync>): string {
  const txt = result.stderr ? result.stderr.toString().trim() : '';
  if (txt) return txt;
  if (result.error) return result.error.message;
  return `exit code ${result.status}`;
}
