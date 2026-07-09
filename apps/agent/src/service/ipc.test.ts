// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { IpcServer } from './ipcServer.js';
import { IpcClient } from './ipcClient.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'qs-ipc-test-'));
}

describe('IPC Server + Client', () => {
  let tmpDir: string;
  let server: IpcServer;
  const clients: IpcClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    if (server) await server.close();
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  function socketPath(): string {
    tmpDir = makeTmpDir();
    return join(tmpDir, 'test.sock');
  }

  async function createServer(): Promise<string> {
    const sock = socketPath();
    server = new IpcServer({ version: '0.8.8' });
    await server.listen(sock);
    return sock;
  }

  async function createClient(sock: string): Promise<{ client: IpcClient; hello: any }> {
    const client = new IpcClient();
    const hello = await client.connect(sock);
    clients.push(client);
    return { client, hello };
  }

  it('hello handshake returns daemon version info', async () => {
    const sock = await createServer();
    const { hello } = await createClient(sock);

    expect(hello.daemonVersion).toBe('0.8.8');
    expect(hello.daemonIpcVersion).toBe(1);
    expect(hello.daemonPid).toBe(process.pid);
    expect(typeof hello.daemonBuildId).toBe('string');
  });

  it('ping returns uptime and version', async () => {
    const sock = await createServer();
    const { client } = await createClient(sock);

    const result = await client.request<any>('ping');
    expect(result.version).toBe('0.8.8');
    expect(result.ipcVersion).toBe(1);
    expect(typeof result.uptime).toBe('number');
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('status returns daemon status summary', async () => {
    const sock = await createServer();
    const { client } = await createClient(sock);

    const result = await client.request<any>('status');
    expect(result.pid).toBe(process.pid);
    expect(result.version).toBe('0.8.8');
    expect(typeof result.uptime).toBe('number');
    expect(result.connectionState).toBe('disconnected');
    expect(result.peerCount).toBe(0);
  });

  it('unknown method returns error', async () => {
    const sock = await createServer();
    const { client } = await createClient(sock);

    await expect(client.request('nonexistent')).rejects.toThrow('Method not found');
  });

  it('custom method handler works', async () => {
    const sock = await createServer();
    server.registerMethod('echo', (params) => ({ echoed: params }));

    const { client } = await createClient(sock);
    const result = await client.request<any>('echo', { message: 'hello' });
    expect(result.echoed).toEqual({ message: 'hello' });
  });

  it('multiple clients can connect', async () => {
    const sock = await createServer();
    const { client: c1 } = await createClient(sock);
    const { client: c2 } = await createClient(sock);

    const r1 = await c1.request<any>('ping');
    const r2 = await c2.request<any>('ping');

    expect(r1.version).toBe('0.8.8');
    expect(r2.version).toBe('0.8.8');
    expect(server.getClientCount()).toBe(2);
  });

  it('subscribe-events enables notifications', async () => {
    const sock = await createServer();
    const { client } = await createClient(sock);

    const received: any[] = [];
    client.onNotification((method, params) => {
      received.push({ method, params });
    });

    await client.request('subscribe-events');

    // Broadcast a notification
    server.broadcast({
      jsonrpc: '2.0',
      method: 'event.test',
      params: { foo: 'bar' },
    });

    // Give the event a moment to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(received.length).toBe(1);
    expect(received[0].method).toBe('event.test');
    expect(received[0].params).toEqual({ foo: 'bar' });
  });

  it('shutdown request triggers shutdown event', async () => {
    const sock = await createServer();
    const { client } = await createClient(sock);

    let shutdownRequested = false;
    server.on('shutdown-requested', () => {
      shutdownRequested = true;
    });

    const result = await client.request<any>('shutdown');
    expect(result.ok).toBe(true);

    // Wait for setImmediate to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(shutdownRequested).toBe(true);
  });

  it('shutdown response reaches client before server closes sockets', async () => {
    // Regression: if the server destroyed client sockets before flushing the
    // {ok:true} response, the client's pending request would reject with
    // IpcDisconnectedError — breaking `quicksave service stop`.
    const sock = await createServer();
    const { client } = await createClient(sock);

    server.on('shutdown-requested', () => {
      // Immediately close the server, mirroring the daemon's real handler.
      void server.close();
    });

    const result = await client.request<any>('shutdown');
    expect(result).toEqual({ ok: true });
  });

  it('client disconnect is detected by server', async () => {
    const sock = await createServer();
    const { client } = await createClient(sock);

    expect(server.getClientCount()).toBe(1);

    let disconnected = false;
    server.on('client-disconnected', () => {
      disconnected = true;
    });

    client.close();

    // Wait for the close event to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getClientCount()).toBe(0);
    expect(disconnected).toBe(true);
  });
});
