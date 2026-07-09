// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * IPC client — connects to the daemon's Unix domain socket
 * and speaks JSON-RPC 2.0 over newline-delimited transport.
 *
 * Used by CLI attach clients and (later) session workers.
 */

import { connect, type Socket } from 'net';
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  HelloParams,
  HelloResult,
} from './types.js';
import { IPC_VERSION, BUILD_ID } from './types.js';

// Package version — matches package.json
const PACKAGE_VERSION = '0.8.8';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class IpcClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private notificationHandler?: (method: string, params: Record<string, unknown>) => void;
  private buffer = '';

  /** Connect to the daemon socket and perform the hello handshake. */
  async connect(socketPath: string): Promise<HelloResult> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let connected = false;

      socket.on('connect', () => {
        connected = true;
        this.socket = socket;
        this.setupDataHandler(socket);

        // Perform hello handshake
        this.request<HelloResult>('hello', {
          role: 'cli',
          version: PACKAGE_VERSION,
          ipcVersion: IPC_VERSION,
          buildId: BUILD_ID,
        } satisfies HelloParams)
          .then(resolve)
          .catch(reject);
      });

      socket.on('error', (err) => {
        if (!connected) {
          reject(err);
        }
      });

      socket.on('close', () => {
        // Reject all pending requests
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new IpcDisconnectedError('IPC connection closed'));
        }
        this.pending.clear();
        this.socket = null;
      });
    });
  }

  /** Send a JSON-RPC request and wait for the response. */
  async request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    if (!this.socket) {
      throw new IpcDisconnectedError('Not connected');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      this.socket!.write(JSON.stringify(request) + '\n');
    });
  }

  /** Send a JSON-RPC notification (fire-and-forget, no response expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.socket) return;

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params: params ?? {},
    };

    this.socket.write(JSON.stringify(notification) + '\n');
  }

  /** Register a handler for server-pushed notifications. */
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  /** Close the connection. */
  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  // -----------------------------------------------------------------------
  // Data parsing
  // -----------------------------------------------------------------------

  private setupDataHandler(socket: Socket): void {
    socket.on('data', (data) => {
      this.buffer += data.toString();
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.trim()) {
          this.handleLine(line);
        }
      }
    });
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Ignore malformed messages
    }

    // JSON-RPC response (has id + result/error)
    if (msg.id != null && ('result' in msg || 'error' in msg)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          const err = new RpcError(msg.error.message, msg.error.code);
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // JSON-RPC notification (has method, no id)
    if (msg.method && msg.id == null) {
      this.notificationHandler?.(msg.method, msg.params ?? {});
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class IpcDisconnectedError extends Error {
  code = 'IPC_DISCONNECTED';
  constructor(message: string) {
    super(message);
    this.name = 'IpcDisconnectedError';
  }
}

export class RpcError extends Error {
  constructor(
    message: string,
    public rpcCode: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}
