#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { Command } from 'commander';
// @ts-ignore - no types for qrcode-terminal
import qrcode from 'qrcode-terminal';
import { resolve } from 'path';
import { hostname } from 'os';
import { getConfigPath, rotateKeyPair, addManagedRepo, addManagedCodingPath } from './config.js';
import { GitOperations } from './git/operations.js';
import { runDaemon } from './service/run.js';
import { IpcClient as IpcClientClass } from './service/ipcClient.js';
import { readServiceState } from './service/stateStore.js';
import { isProcessAlive } from './service/singleton.js';
import { isDebugEnabled } from './service/types.js';
import type { StatusResult, PairingInfoResult, DebugResult, AgentStateResult, UnlockPairingResult } from './service/types.js';
import type { CardHistoryResponse } from '@sumicom/quicksave-shared';

const program = new Command();

function collectValues(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .name('quicksave-agent')
  .description('Quicksave desktop agent for remote git control')
  .version('0.8.7')
  .allowExcessArguments(false)
  .option('-r, --repo <path>', 'Path to git repository (can specify multiple)', collectValues, [])
  .option('-c, --coding-path <path>', 'Path for Claude Code sessions (can specify multiple, non-git dirs OK)', collectValues, [])
  .option('-s, --signaling <url>', 'Signaling server URL')
  .option('--no-qr', 'Disable QR code display')
  .option('--restart', 'Shut down existing daemon and start a fresh one')
  .action(async (options) => {
    // Restart mode: wait for old daemon to finish responding, then force-restart
    if (options.restart) {
      await new Promise((r) => setTimeout(r, 1000));
      const { readServiceState } = await import('./service/stateStore.js');
      const { cleanStaleRuntime } = await import('./service/singleton.js');
      const { IpcClient } = await import('./service/ipcClient.js');
      const state = readServiceState();
      if (state) {
        try {
          const client = new IpcClient();
          await client.connect(state.socketPath);
          await client.request('shutdown');
          client.close();
        } catch { /* already gone */ }
        await new Promise((r) => setTimeout(r, 500));
        cleanStaleRuntime();
      }
    }
    // Persist any CLI-provided repos/coding paths to config
    const repoPaths: string[] = options.repo;
    for (const p of repoPaths) {
      addManagedRepo(resolve(p));
    }
    const codingPaths: string[] = options.codingPath || [];
    for (const p of codingPaths) {
      addManagedCodingPath(resolve(p));
    }

    // Auto-detect current directory's repo
    if (repoPaths.length === 0) {
      const cwd = process.cwd();
      const git = new GitOperations(cwd);
      if (await git.isValidRepo()) {
        const root = await git.getGitRoot();
        addManagedRepo(root);
        repoPaths.push(root);
      }
    }

    // Ensure daemon is running
    const { ensureDaemon } = await import('./service/ensureDaemon.js');
    let client: IpcClientClass;
    try {
      const result = await ensureDaemon();
      client = result.client;
      console.log(`Quicksave Agent v0.8.7 (daemon pid: ${result.hello.daemonPid})`);
      console.log('='.repeat(50));
    } catch (err) {
      console.error('Failed to connect to daemon:', (err as Error).message);
      process.exit(1);
    }

    // Notify the running daemon about repos (idempotent — no-op if already known)
    for (const p of repoPaths) {
      try {
        await client.request('add-repo', { path: resolve(p) });
      } catch { /* daemon already has it or will pick it up on restart */ }
    }

    // Get pairing info and display
    try {
      const info = await client.request<PairingInfoResult>('get-pairing-info');
      console.log(`Config: ${getConfigPath()}`);
      console.log('');
      displayPairingInfo(info, options.qr);
    } catch (err) {
      console.error('Failed to get pairing info:', (err as Error).message);
    }

    client.close();
  });

function displayPairingInfo(info: PairingInfoResult, showQr: boolean): void {
  console.log('Agent ID:');
  console.log(`  ${info.agentId}`);
  console.log('');

  console.log('Connection URL:');
  console.log(`  ${info.pairingUrl}`);
  console.log('');

  if (showQr) {
    console.log('Scan QR code to connect:');
    console.log('');
    qrcode.generate(info.pairingUrl, { small: true });
  }

  console.log('');
  if (info.peerCount > 0) {
    console.log(`Connected to ${info.peerCount} peer${info.peerCount !== 1 ? 's' : ''}`);
  } else {
    console.log('Waiting for PWA connection...');
  }
}

program
  .command('rotate-keys')
  .description('Generate a new keypair (invalidates all existing PWA connections)')
  .action(() => {
    try {
      const config = rotateKeyPair();
      console.log('\nKey pair rotated successfully.\n');
      console.log(`  Agent ID:    ${config.agentId} (unchanged)`);
      console.log(`  Public Key:  ${config.keyPair.publicKey} (NEW)\n`);
      console.log('All existing PWA connections are now invalid.');
      console.log('Re-scan the QR code on your trusted devices to reconnect.\n');
      const pairingUrl = `https://quicksave.dev/#/connect/${config.agentId}?pk=${encodeURIComponent(config.keyPair.publicKey)}&spk=${encodeURIComponent(config.signKeyPair.publicKey)}&name=${encodeURIComponent(hostname())}`;
      console.log('Connection URL:');
      console.log(`  ${pairingUrl}\n`);
      qrcode.generate(pairingUrl, { small: true });
    } catch (err) {
      console.error('Failed to rotate keys:', (err as Error).message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Pair state commands
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show agent pairing state (unpaired | paired | closed)')
  .action(async () => {
    try {
      await withDaemon(async (client) => {
        const s = await client.request<AgentStateResult>('get-agent-state');
        console.log(`State:       ${s.state}`);
        console.log(`Agent ID:    ${s.agentId}`);
        console.log(`Signaling:   ${s.connectionState}`);
        console.log(`Peers:       ${s.peerCount}`);
        if (s.peerPWAPublicKey) {
          console.log(`Peer PWA pk: ${s.peerPWAPublicKey.slice(0, 24)}…`);
        } else {
          console.log(`Peer PWA:    (not pinned)`);
        }
        if (s.state === 'closed') {
          console.log('');
          console.log('Agent is closed after a tombstone event.');
          console.log('Run `quicksave pair` to re-enable pairing.');
        }
      });
    } catch (err) {
      console.error('Failed to query daemon:', (err as Error).message);
      process.exit(1);
    }
  });

program
  .command('pair')
  .description('Reset pairing lock (after tombstone) and show connection URL')
  .option('--no-qr', 'Disable QR code display')
  .action(async (options: { qr?: boolean }) => {
    try {
      await withDaemon(async (client) => {
        const unlock = await client.request<UnlockPairingResult>('unlock-pairing');
        if (unlock.previousState === 'closed') {
          console.log('Closed state cleared — agent is ready to pair.');
          console.log('');
        } else if (unlock.previousState === 'paired') {
          console.log('Agent is already paired; showing existing connection URL.');
          console.log('(Use `rotate-keys` on the PWA to re-pair from scratch.)');
          console.log('');
        }
        const info = await client.request<PairingInfoResult>('get-pairing-info');
        displayPairingInfo(info, options.qr !== false);
      });
    } catch (err) {
      console.error('Failed to pair:', (err as Error).message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Service subcommands
// ---------------------------------------------------------------------------

const serviceCmd = program
  .command('service')
  .description('Manage the quicksave background service');

serviceCmd
  .command('run')
  .description('Run the daemon in the foreground (not normally invoked directly)')
  .action(async () => {
    await runDaemon();
  });

serviceCmd
  .command('start')
  .description('Start the background daemon')
  .action(async () => {
    // Check if already running
    const state = readServiceState();
    if (state && isProcessAlive(state.pid)) {
      console.log(`Daemon is already running (pid: ${state.pid})`);
      return;
    }

    const { ensureDaemon } = await import('./service/ensureDaemon.js');
    try {
      const { client, hello } = await ensureDaemon();
      client.close();
      console.log(`Daemon started (pid: ${hello.daemonPid})`);
    } catch (err) {
      console.error('Failed to start daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('stop')
  .description('Stop the running daemon')
  .action(async () => {
    const state = readServiceState();
    if (!state) {
      console.log('No daemon is running.');
      return;
    }

    if (!isProcessAlive(state.pid)) {
      console.log('Daemon process is dead. Cleaning up stale files...');
      const { cleanStaleRuntime } = await import('./service/singleton.js');
      const { removeServiceState } = await import('./service/stateStore.js');
      cleanStaleRuntime();
      removeServiceState();
      console.log('Done.');
      return;
    }

    try {
      const client = new IpcClientClass();
      await client.connect(state.socketPath);
      await client.request('shutdown');
      client.close();
      console.log('Daemon stopped.');
    } catch (err) {
      console.error('Failed to stop daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    const state = readServiceState();
    if (!state) {
      console.log('No daemon is running.');
      return;
    }

    if (!isProcessAlive(state.pid)) {
      console.log('Daemon process is dead (stale service.json).');
      console.log(`  Last PID: ${state.pid}`);
      console.log(`  Started:  ${state.startedAt}`);
      return;
    }

    try {
      const client = new IpcClientClass();
      await client.connect(state.socketPath);
      const status = await client.request<StatusResult>('status');
      client.close();

      console.log('Quicksave daemon is running');
      console.log(`  PID:              ${status.pid}`);
      console.log(`  Version:          ${status.version}`);
      console.log(`  Uptime:           ${formatUptime(status.uptime)}`);
      console.log(`  Connection:       ${status.connectionState}`);
      console.log(`  Peers:            ${status.peerCount}`);
      console.log(`  Active sessions:  ${status.activeSessions}`);
      console.log(`  Managed repos:    ${status.managedRepos}`);
    } catch (err) {
      console.error('Failed to query daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('info')
  .description('Show daemon info from service.json (no IPC required)')
  .action(() => {
    const state = readServiceState();
    if (!state) {
      console.log('No service state file found.');
      return;
    }

    const alive = isProcessAlive(state.pid);
    console.log(`PID:        ${state.pid} (${alive ? 'alive' : 'dead'})`);
    console.log(`Version:    ${state.version}`);
    console.log(`IPC:        ${state.ipcVersion}`);
    console.log(`Build ID:   ${state.buildId}`);
    console.log(`Started:    ${state.startedAt}`);
    console.log(`Heartbeat:  ${state.lastHeartbeatAt}`);
    console.log(`Socket:     ${state.socketPath}`);
    console.log(`Agent ID:   ${state.agentId}`);
    console.log(`Signaling:  ${state.signalingServer}`);
    console.log(`Connection: ${state.connectionState}`);
    console.log(`Peers:      ${state.peerCount}`);
  });

// `enable-boot` is the only place the user-scoped install path needs root —
// `loginctl enable-linger` writes to `/var/lib/systemd/linger/<user>` which
// only root or polkit can touch. The PWA can't prompt for sudo (no TTY, no
// display), so we provide this CLI helper as the canonical "make the unit
// survive logout / start at boot" knob. It just shells out to sudo with
// inherited stdio — the user types their password into their own terminal.
serviceCmd
  .command('enable-boot')
  .description('Enable the systemd user instance to start at boot (runs `sudo loginctl enable-linger $USER`)')
  .action(async () => {
    const { platform } = await import('os');
    if (platform() !== 'linux') {
      console.error('enable-boot is Linux-only (uses systemd `loginctl enable-linger`).');
      process.exit(1);
    }
    const { lingerIsEnabled } = await import('./service/systemdUnit.js');
    if (lingerIsEnabled()) {
      console.log('Lingering is already enabled — the agent will run at boot.');
      return;
    }
    const user = process.env.USER || process.env.LOGNAME;
    if (!user) {
      console.error('Cannot determine current user (USER / LOGNAME unset).');
      process.exit(1);
    }
    const { spawnSync } = await import('child_process');
    console.log(`Running: sudo loginctl enable-linger ${user}`);
    const result = spawnSync('sudo', ['loginctl', 'enable-linger', user], { stdio: 'inherit' });
    if (result.error) {
      console.error('Failed to invoke sudo:', result.error.message);
      process.exit(1);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
    console.log('Lingering enabled. The systemd user instance will now start at boot.');
    console.log('Tip: run `quicksave service status` to confirm the daemon comes up after the next reboot.');
  });

// ---------------------------------------------------------------------------
// Helper: connect to running daemon, run callback, close
// ---------------------------------------------------------------------------
async function withDaemon<T>(fn: (client: InstanceType<typeof IpcClientClass>) => Promise<T>): Promise<T> {
  const state = readServiceState();
  if (!state) { console.error('No daemon is running.'); process.exit(1); }
  if (!isProcessAlive(state.pid)) { console.error('Daemon process is dead.'); process.exit(1); }
  const client = new IpcClientClass();
  await client.connect(state.socketPath);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Debug commands — disabled in production unless QUICKSAVE_DEBUG=1
// ---------------------------------------------------------------------------

if (isDebugEnabled()) {

serviceCmd
  .command('debug')
  .description('Show daemon internal state (peers, subscriptions, pending permissions, sessions)')
  .action(async () => {
    try {
      await withDaemon(async (client) => {
        const d = await client.request<DebugResult>('debug');
        console.log(`Quicksave Debug (pid: ${d.pid}, uptime: ${formatUptime(Math.floor(d.uptime))})\n`);

        console.log(`Peers (${d.peers.length}):`);
        if (d.peers.length === 0) console.log('  (none)');
        for (const p of d.peers) {
          const ago = Math.floor((Date.now() - p.connectedAt) / 1000);
          console.log(`  ${p.address}  connected ${formatUptime(ago)} ago  topics: [${p.topics.join(', ')}]`);
        }

        console.log(`\nSubscriptions:`);
        const subs = Object.entries(d.subscriptions);
        if (subs.length === 0) console.log('  (none)');
        for (const [topic, addrs] of subs) {
          console.log(`  ${topic.padEnd(28)} → ${addrs.length} peer${addrs.length !== 1 ? 's' : ''}`);
        }

        console.log(`\nPending Inputs (${d.pendingInputs.length}):`);
        if (d.pendingInputs.length === 0) console.log('  (none)');
        for (const p of d.pendingInputs) {
          console.log(`  ${p.requestId}  session=${p.sessionId.slice(0, 8)}  tool=${p.toolName ?? 'unknown'}  agentId=${p.agentId ?? 'none'}  type=${p.inputType}`);
        }

        console.log(`\nActive Sessions (${d.activeSessions.length}):`);
        if (d.activeSessions.length === 0) console.log('  (none)');
        for (const s of d.activeSessions) {
          console.log(`  ${s.sessionId.slice(0, 8)}  cwd=${s.cwd}  streaming=${s.isStreaming}  pending=${s.hasPendingInput}  mode=${s.permissionMode}`);
        }
      });
    } catch (err) {
      console.error('Failed to query daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('sessions')
  .description('List all sessions (SDK + live state)')
  .option('--cwd <path>', 'Working directory for session lookup')
  .action(async (opts) => {
    try {
      await withDaemon(async (client) => {
        const params: Record<string, unknown> = {};
        if (opts.cwd) params.cwd = resolve(opts.cwd);
        const { sessions } = await client.request<{ sessions: Array<Record<string, unknown>> }>('list-sessions', params);

        console.log(`Sessions (${sessions.length}):`);
        if (sessions.length === 0) { console.log('  (none)'); return; }
        for (const s of sessions) {
          const id = (s.sessionId as string).slice(0, 8);
          // Status terminology:
          //   closed    — registry-only, not in the daemon's in-memory map; a
          //               cold resume would spawn a fresh provider process.
          //   streaming — in-memory with an active turn in flight.
          //   idle      — in-memory, provider alive between turns, awaiting
          //               user input (hot-resumable without a re-spawn).
          let status: string;
          if (!s.isActive) status = 'closed';
          else if (s.isStreaming) status = 'streaming';
          else status = 'idle';
          const pending = s.hasPendingInput ? '  pending' : '';
          const mode = s.permissionMode ? `  mode=${s.permissionMode}` : '';
          const prompt = s.prompt ? `  "${(s.prompt as string).slice(0, 40)}${(s.prompt as string).length > 40 ? '...' : ''}"` : '';
          console.log(`  ${id}  ${status}${pending}${mode}${prompt}`);
        }
      });
    } catch (err) {
      console.error('Failed to query daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('cards <sessionId>')
  .description('Show card history for a session')
  .option('--cwd <path>', 'Working directory')
  .option('--limit <n>', 'Max cards to show', '30')
  .action(async (sessionId: string, opts) => {
    try {
      await withDaemon(async (client) => {
        const params: Record<string, unknown> = { sessionId, limit: parseInt(opts.limit) };
        if (opts.cwd) params.cwd = resolve(opts.cwd);
        const result = await client.request<CardHistoryResponse>('get-cards', params);

        const pendingCount = result.pendingInputs?.length ?? 0;
        console.log(`Cards for session ${sessionId.slice(0, 8)} (${result.total} total, ${pendingCount} pending):\n`);

        for (let i = 0; i < result.cards.length; i++) {
          const c = result.cards[i];
          const num = `#${i + 1}`.padEnd(4);
          const type = c.type.padEnd(16);
          let detail = '';
          switch (c.type) {
            case 'user': detail = `"${(c as any).text?.slice(0, 60) ?? ''}"`; break;
            case 'assistant_text': detail = `"${(c as any).text?.slice(0, 60) ?? ''}"`; break;
            case 'tool_call': {
              const tc = c as any;
              detail = tc.toolName ?? '';
              if (tc.result) detail += `  result=${JSON.stringify(tc.result).slice(0, 40)}`;
              if (c.pendingInput) detail += `  ⏳ ${c.pendingInput.requestId}`;
              break;
            }
            case 'subagent': {
              const sa = c as any;
              detail = `agentId=${sa.agentId?.slice(0, 12) ?? '?'}  status=${sa.status}  tools=${sa.toolUseCount ?? 0}`;
              if (c.pendingInput) detail += `  ⏳ ${c.pendingInput.requestId}`;
              break;
            }
            case 'thinking': detail = `"${(c as any).text?.slice(0, 60) ?? ''}"`; break;
            case 'system': detail = `[${(c as any).subtype ?? 'info'}] "${(c as any).text?.slice(0, 50) ?? ''}"`; break;
          }
          console.log(`  ${num}${type}${detail}`);
        }

        if (result.pendingInputs && result.pendingInputs.length > 0) {
          console.log(`\nPending Inputs:`);
          for (const p of result.pendingInputs) {
            console.log(`  ${p.requestId}  tool=${p.toolName ?? 'unknown'}  agentId=${(p as any).agentId ?? 'none'}  type=${p.inputType}`);
          }
        }
      });
    } catch (err) {
      console.error('Failed to query daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('resolve <requestId>')
  .description('Force-resolve a stuck permission request')
  .option('--deny', 'Deny instead of allow')
  .action(async (requestId: string, opts) => {
    try {
      await withDaemon(async (client) => {
        const action = opts.deny ? 'deny' : 'allow';
        const { resolved } = await client.request<{ resolved: boolean }>('resolve-input', { requestId, action });
        if (resolved) {
          console.log(`Resolved ${requestId} (action: ${action})`);
        } else {
          console.log(`Request ${requestId} not found in pending queue.`);
        }
      });
    } catch (err) {
      console.error('Failed:', (err as Error).message);
      process.exit(1);
    }
  });

} // end isDebugEnabled()

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

program.parse();
