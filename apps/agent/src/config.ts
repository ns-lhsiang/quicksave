// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { generateAgentKeyPair } from './connection/connection.js';
import { generateAgentId, generateSigningKeyPair, encodeKeyPair, type License } from '@sumicom/quicksave-shared';
import { getQuicksaveDir, getConfigFile } from './service/singleton.js';

export interface AgentConfig {
  agentId: string;
  keyPair: {
    publicKey: string;
    secretKey: string;
  };
  signKeyPair: {
    publicKey: string;
    secretKey: string;
  };
  /**
   * TOFU-pinned PWA group identity. `null` on a fresh / closed agent, which
   * accepts the first successful V2 handshake as the trust anchor and writes
   * both fields here. Once pinned, subsequent handshakes must prove possession
   * of the same Ed25519 signing key before they are accepted.
   *
   * Cleared (set back to `null`) when a tombstone is observed on the pinned
   * mailbox — the agent then enters the "closed" state until the user runs
   * `quicksave pair` again.
   */
  peerPWAPublicKey?: string | null;
  peerPWASignPublicKey?: string | null;
  /**
   * Sticky self-destruct flag set after a verified tombstone. Persists across
   * daemon restarts so a crash/restart window can't silently re-open TOFU.
   * Cleared only by `unlockPairingAndRotate()` (driven by `quicksave pair`).
   */
  closed?: boolean;
  license?: License;
  signalingServer: string;
  anthropicApiKey?: string;
  managedRepos?: string[];
  managedCodingPaths?: string[];
}

const DEFAULT_SIGNALING_SERVER = 'ws://localhost:8080';

export function ensureConfigDir(): void {
  const dir = getQuicksaveDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): AgentConfig | null {
  try {
    if (existsSync(getConfigFile())) {
      const data = readFileSync(getConfigFile(), 'utf-8');
      return JSON.parse(data) as AgentConfig;
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
  return null;
}

export function saveConfig(config: AgentConfig): void {
  ensureConfigDir();
  writeFileSync(getConfigFile(), JSON.stringify(config, null, 2));
}

export function createDefaultConfig(signalingServer: string): AgentConfig {
  const config: AgentConfig = {
    agentId: generateAgentId(),
    keyPair: generateAgentKeyPair(),
    signKeyPair: encodeKeyPair(generateSigningKeyPair()),
    peerPWAPublicKey: null,
    peerPWASignPublicKey: null,
    closed: false,
    signalingServer,
  };
  saveConfig(config);
  return config;
}

export function getOrCreateConfig(signalingServer: string): AgentConfig {
  let config = loadConfig();

  if (!config) {
    console.log('No existing config found, generating new identity...');
    config = createDefaultConfig(signalingServer);
    console.log('New agent identity created');
  } else {
    let dirty = false;
    // Backfill signing keypair for configs created before Ed25519 push auth.
    if (!config.signKeyPair) {
      config.signKeyPair = encodeKeyPair(generateSigningKeyPair());
      dirty = true;
    }
    // Pre-TOFU configs are legacy unpaired → normalize missing fields to null.
    if (config.peerPWAPublicKey === undefined) {
      config.peerPWAPublicKey = null;
      dirty = true;
    }
    if (config.peerPWASignPublicKey === undefined) {
      config.peerPWASignPublicKey = null;
      dirty = true;
    }
    if (config.closed === undefined) {
      config.closed = false;
      dirty = true;
    }
    if (config.signalingServer !== signalingServer) {
      config.signalingServer = signalingServer;
      dirty = true;
    }
    if (dirty) saveConfig(config);
  }

  return config;
}

export function addLicense(license: License): void {
  const config = loadConfig();
  if (config) {
    config.license = license;
    saveConfig(config);
  }
}

export function getConfigPath(): string {
  return getConfigFile();
}

// Anthropic API Key helpers
export function getAnthropicApiKey(): string | undefined {
  return loadConfig()?.anthropicApiKey;
}

export function setAnthropicApiKey(apiKey: string): void {
  const config = loadConfig();
  if (config) {
    config.anthropicApiKey = apiKey;
    saveConfig(config);
  }
}

export function hasAnthropicApiKey(): boolean {
  return !!loadConfig()?.anthropicApiKey;
}

// Managed repos helpers
export function getManagedRepos(): string[] {
  return loadConfig()?.managedRepos ?? [];
}

export function addManagedRepo(path: string): void {
  const config = loadConfig() ?? getOrCreateConfig(DEFAULT_SIGNALING_SERVER);
  const repos = config.managedRepos ?? [];
  if (!repos.includes(path)) {
    repos.push(path);
    config.managedRepos = repos;
    saveConfig(config);
  }
}

export function removeManagedRepo(path: string): void {
  const config = loadConfig();
  if (!config) return;
  const repos = config.managedRepos ?? [];
  const idx = repos.indexOf(path);
  if (idx !== -1) {
    repos.splice(idx, 1);
    config.managedRepos = repos;
    saveConfig(config);
  }
}

// Managed coding paths helpers
export function getManagedCodingPaths(): string[] {
  return loadConfig()?.managedCodingPaths ?? [];
}

export function addManagedCodingPath(path: string): void {
  const config = loadConfig() ?? getOrCreateConfig(DEFAULT_SIGNALING_SERVER);
  const paths = config.managedCodingPaths ?? [];
  if (!paths.includes(path)) {
    paths.push(path);
    config.managedCodingPaths = paths;
    saveConfig(config);
  }
}

export function removeManagedCodingPath(path: string): void {
  const config = loadConfig();
  if (!config) return;
  const paths = config.managedCodingPaths ?? [];
  const idx = paths.indexOf(path);
  if (idx !== -1) {
    paths.splice(idx, 1);
    config.managedCodingPaths = paths;
    saveConfig(config);
  }
}

/**
 * Rotate the agent's key pair (keeps the same agentId).
 * This invalidates all existing PWA connections.
 */
export function rotateKeyPair(): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found. Run the agent first to generate a config.');
  }
  config.keyPair = generateAgentKeyPair();
  saveConfig(config);
  return config;
}

/** True iff the agent has TOFU-pinned a PWA group identity. */
export function isPaired(config: AgentConfig = loadConfig()!): boolean {
  return (
    !!config &&
    !!config.peerPWAPublicKey &&
    !!config.peerPWASignPublicKey
  );
}

/**
 * Pin the given PWA group identity as this agent's trust anchor. Idempotent
 * if the same pair is already stored; throws if a *different* pair is already
 * pinned (caller must `clearPeerPWA` first, which is the tombstone path).
 */
export function pinPeerPWA(
  peerPWAPublicKey: string,
  peerPWASignPublicKey: string,
): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found. Run the agent first to generate a config.');
  }
  if (config.peerPWAPublicKey && config.peerPWASignPublicKey) {
    if (
      config.peerPWAPublicKey === peerPWAPublicKey &&
      config.peerPWASignPublicKey === peerPWASignPublicKey
    ) {
      return config;
    }
    throw new Error(
      'Agent is already paired with a different PWA group identity. ' +
        'Clear the pairing (rotate-keys tombstone or manual reset) first.',
    );
  }
  config.peerPWAPublicKey = peerPWAPublicKey;
  config.peerPWASignPublicKey = peerPWASignPublicKey;
  saveConfig(config);
  return config;
}

/**
 * Forget the pinned PWA group identity. Called when a signed tombstone is
 * observed on the pinned mailbox. Rotates the agent's entire cryptographic
 * identity (`agentId`, X25519 box keypair, Ed25519 signing keypair) so the
 * old routing address and keys can no longer be used, and sets `closed: true`
 * so the agent refuses every inbound handshake until `quicksave pair`.
 */
export function clearPeerPWA(): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found.');
  }
  config.peerPWAPublicKey = null;
  config.peerPWASignPublicKey = null;
  config.agentId = generateAgentId();
  config.keyPair = generateAgentKeyPair();
  config.signKeyPair = encodeKeyPair(generateSigningKeyPair());
  config.closed = true;
  saveConfig(config);
  return config;
}

/**
 * Lift the `closed` gate and produce a fresh agent identity. Called by the
 * `quicksave pair` CLI path: even if the agent was already in a fresh state
 * after tombstone, rotating again here means each new pairing attempt comes
 * with an unburdened identity — no lingering state from prior pairings.
 */
export function unlockPairingAndRotate(): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found.');
  }
  config.peerPWAPublicKey = null;
  config.peerPWASignPublicKey = null;
  config.agentId = generateAgentId();
  config.keyPair = generateAgentKeyPair();
  config.signKeyPair = encodeKeyPair(generateSigningKeyPair());
  config.closed = false;
  saveConfig(config);
  return config;
}
