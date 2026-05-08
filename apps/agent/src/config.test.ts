// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import type { AgentConfig } from './config.js';

vi.mock('fs');
vi.mock('os', () => ({ homedir: vi.fn(() => '/fake/home') }));
vi.mock('./connection/connection.js', () => ({
  generateAgentKeyPair: () => ({ publicKey: 'mock-pk', secretKey: 'mock-sk' }),
}));
vi.mock('@sumicom/quicksave-shared', () => ({
  generateAgentId: () => 'mock-agent-id',
  generateSigningKeyPair: () => ({
    publicKey: new Uint8Array([1, 2, 3]),
    secretKey: new Uint8Array([4, 5, 6]),
  }),
  encodeKeyPair: () => ({ publicKey: 'mock-sign-pk', secretKey: 'mock-sign-sk' }),
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

const {
  loadConfig,
  saveConfig,
  ensureConfigDir,
  createDefaultConfig,
  getOrCreateConfig,
  getConfigPath,
  getAnthropicApiKey,
  setAnthropicApiKey,
  hasAnthropicApiKey,
  getManagedRepos,
  addManagedRepo,
  removeManagedRepo,
  getManagedCodingPaths,
  addManagedCodingPath,
  rotateKeyPair,
  addLicense,
  isPaired,
  pinPeerPWA,
  clearPeerPWA,
  unlockPairingAndRotate,
} = await import('./config.js');

const CONFIG_DIR = '/fake/home/.quicksave';
const CONFIG_FILE = '/fake/home/.quicksave/agent.json';

const baseConfig: AgentConfig = {
  agentId: 'test-agent',
  keyPair: { publicKey: 'pk', secretKey: 'sk' },
  signKeyPair: { publicKey: 'sign-pk', secretKey: 'sign-sk' },
  signalingServer: 'ws://localhost:8080',
};

function mockConfigFile(config: AgentConfig | null) {
  if (config) {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(config));
  } else {
    mockedExistsSync.mockReturnValue(false);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getConfigPath', () => {
  it('returns the config file path under ~/.quicksave', () => {
    expect(getConfigPath()).toBe(CONFIG_FILE);
  });
});

describe('ensureConfigDir', () => {
  it('creates the config directory if it does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    ensureConfigDir();
    expect(mockedMkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
  });

  it('does not create the directory if it already exists', () => {
    mockedExistsSync.mockReturnValue(true);
    ensureConfigDir();
    expect(mockedMkdirSync).not.toHaveBeenCalled();
  });
});

describe('loadConfig', () => {
  it('returns null when config file does not exist', () => {
    mockConfigFile(null);
    expect(loadConfig()).toBeNull();
  });

  it('parses and returns the config when file exists', () => {
    mockConfigFile(baseConfig);
    expect(loadConfig()).toEqual(baseConfig);
  });

  it('returns null on parse error', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('bad json');
    expect(loadConfig()).toBeNull();
  });
});

describe('saveConfig', () => {
  it('ensures config dir and writes pretty-printed JSON', () => {
    // ensureConfigDir checks existsSync for CONFIG_DIR
    mockedExistsSync.mockReturnValue(true);
    saveConfig(baseConfig);
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      CONFIG_FILE,
      JSON.stringify(baseConfig, null, 2),
    );
  });
});

describe('createDefaultConfig', () => {
  it('generates a config with mocked id and keypairs, then saves it', () => {
    mockedExistsSync.mockReturnValue(true);
    const config = createDefaultConfig('wss://signal.example.com');
    expect(config.agentId).toBe('mock-agent-id');
    expect(config.keyPair).toEqual({ publicKey: 'mock-pk', secretKey: 'mock-sk' });
    expect(config.signKeyPair).toEqual({ publicKey: 'mock-sign-pk', secretKey: 'mock-sign-sk' });
    expect(config.signalingServer).toBe('wss://signal.example.com');
    expect(mockedWriteFileSync).toHaveBeenCalled();
  });
});

describe('getOrCreateConfig', () => {
  it('creates a new config when none exists', () => {
    mockedExistsSync.mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = getOrCreateConfig('ws://localhost:8080');
    expect(config.agentId).toBe('mock-agent-id');
    consoleSpy.mockRestore();
  });

  it('returns existing config when signaling server matches and peerPWA* already normalized', () => {
    // Use a config that already has peerPWA* + closed explicitly set —
    // otherwise getOrCreateConfig will backfill them and trigger a re-save.
    const stableConfig = {
      ...baseConfig,
      peerPWAPublicKey: null,
      peerPWASignPublicKey: null,
      closed: false,
    };
    mockConfigFile(stableConfig);
    const config = getOrCreateConfig('ws://localhost:8080');
    expect(config).toEqual(stableConfig);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('updates signaling server when it has changed', () => {
    mockConfigFile(baseConfig);
    const config = getOrCreateConfig('wss://new-signal.example.com');
    expect(config.signalingServer).toBe('wss://new-signal.example.com');
    expect(mockedWriteFileSync).toHaveBeenCalled();
  });

  it('backfills signKeyPair when missing from an older config', () => {
    const legacyConfig = { ...baseConfig } as any;
    delete legacyConfig.signKeyPair;
    mockConfigFile(legacyConfig);
    const config = getOrCreateConfig('ws://localhost:8080');
    expect(config.signKeyPair).toEqual({ publicKey: 'mock-sign-pk', secretKey: 'mock-sign-sk' });
    expect(mockedWriteFileSync).toHaveBeenCalled();
  });
});

describe('addLicense', () => {
  it('adds a license to existing config', () => {
    mockConfigFile(baseConfig);
    const license = { key: 'lic-123', tier: 'pro' } as any;
    addLicense(license);
    const savedJson = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    const saved = JSON.parse(savedJson);
    expect(saved.license).toEqual(license);
  });

  it('does nothing when no config exists', () => {
    mockConfigFile(null);
    addLicense({ key: 'lic-123' } as any);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('Anthropic API key helpers', () => {
  it('getAnthropicApiKey returns undefined when no config', () => {
    mockConfigFile(null);
    expect(getAnthropicApiKey()).toBeUndefined();
  });

  it('getAnthropicApiKey returns the key from config', () => {
    mockConfigFile({ ...baseConfig, anthropicApiKey: 'sk-test' });
    expect(getAnthropicApiKey()).toBe('sk-test');
  });

  it('setAnthropicApiKey updates the config', () => {
    mockConfigFile(baseConfig);
    setAnthropicApiKey('sk-new');
    const savedJson = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(JSON.parse(savedJson).anthropicApiKey).toBe('sk-new');
  });

  it('hasAnthropicApiKey returns false when no key', () => {
    mockConfigFile(baseConfig);
    expect(hasAnthropicApiKey()).toBe(false);
  });

  it('hasAnthropicApiKey returns true when key exists', () => {
    mockConfigFile({ ...baseConfig, anthropicApiKey: 'sk-test' });
    expect(hasAnthropicApiKey()).toBe(true);
  });
});

describe('managed repos helpers', () => {
  it('getManagedRepos returns empty array when no config', () => {
    mockConfigFile(null);
    expect(getManagedRepos()).toEqual([]);
  });

  it('getManagedRepos returns repos from config', () => {
    mockConfigFile({ ...baseConfig, managedRepos: ['/repo/a', '/repo/b'] });
    expect(getManagedRepos()).toEqual(['/repo/a', '/repo/b']);
  });

  it('addManagedRepo adds a new repo path', () => {
    mockConfigFile(baseConfig);
    addManagedRepo('/repo/new');
    const savedJson = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(JSON.parse(savedJson).managedRepos).toEqual(['/repo/new']);
  });

  it('addManagedRepo does not add duplicates', () => {
    mockConfigFile({ ...baseConfig, managedRepos: ['/repo/a'] });
    addManagedRepo('/repo/a');
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('removeManagedRepo removes a repo', () => {
    mockConfigFile({ ...baseConfig, managedRepos: ['/repo/a', '/repo/b'] });
    removeManagedRepo('/repo/a');
    const savedJson = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(JSON.parse(savedJson).managedRepos).toEqual(['/repo/b']);
  });

  it('removeManagedRepo does nothing when repo not found', () => {
    mockConfigFile({ ...baseConfig, managedRepos: ['/repo/a'] });
    removeManagedRepo('/repo/missing');
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('removeManagedRepo does nothing when no config', () => {
    mockConfigFile(null);
    removeManagedRepo('/repo/a');
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('managed coding paths helpers', () => {
  it('getManagedCodingPaths returns empty array when no config', () => {
    mockConfigFile(null);
    expect(getManagedCodingPaths()).toEqual([]);
  });

  it('addManagedCodingPath adds a new path', () => {
    mockConfigFile(baseConfig);
    addManagedCodingPath('/code/project');
    const savedJson = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(JSON.parse(savedJson).managedCodingPaths).toEqual(['/code/project']);
  });

  it('addManagedCodingPath does not add duplicates', () => {
    mockConfigFile({ ...baseConfig, managedCodingPaths: ['/code/x'] });
    addManagedCodingPath('/code/x');
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('rotateKeyPair', () => {
  it('generates a new key pair and saves it', () => {
    mockConfigFile(baseConfig);
    const result = rotateKeyPair();
    expect(result.keyPair).toEqual({ publicKey: 'mock-pk', secretKey: 'mock-sk' });
    expect(result.agentId).toBe(baseConfig.agentId); // agentId preserved
    expect(mockedWriteFileSync).toHaveBeenCalled();
  });

  it('throws when no config exists', () => {
    mockConfigFile(null);
    expect(() => rotateKeyPair()).toThrow('No config found');
  });
});

describe('peer PWA TOFU pinning', () => {
  it('createDefaultConfig sets peerPWA* fields to null', () => {
    mockedExistsSync.mockReturnValue(true);
    const config = createDefaultConfig('wss://signal.example.com');
    expect(config.peerPWAPublicKey).toBeNull();
    expect(config.peerPWASignPublicKey).toBeNull();
  });

  it('getOrCreateConfig backfills peerPWA* as null on pre-TOFU configs', () => {
    // Legacy config missing the peerPWA* fields entirely.
    mockConfigFile(baseConfig);
    const config = getOrCreateConfig('ws://localhost:8080');
    expect(config.peerPWAPublicKey).toBeNull();
    expect(config.peerPWASignPublicKey).toBeNull();
    // Should have rewritten the file with the normalized fields.
    expect(mockedWriteFileSync).toHaveBeenCalled();
    const saved = JSON.parse(
      mockedWriteFileSync.mock.calls[0]![1] as string,
    );
    expect(saved.peerPWAPublicKey).toBeNull();
    expect(saved.peerPWASignPublicKey).toBeNull();
  });

  it('getOrCreateConfig preserves already-pinned peerPWA* fields', () => {
    mockConfigFile({
      ...baseConfig,
      peerPWAPublicKey: 'peer-pk',
      peerPWASignPublicKey: 'peer-sign-pk',
      closed: false,
    });
    const config = getOrCreateConfig('ws://localhost:8080');
    expect(config.peerPWAPublicKey).toBe('peer-pk');
    expect(config.peerPWASignPublicKey).toBe('peer-sign-pk');
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('isPaired returns false on an unpaired config', () => {
    mockConfigFile({
      ...baseConfig,
      peerPWAPublicKey: null,
      peerPWASignPublicKey: null,
    });
    expect(isPaired()).toBe(false);
  });

  it('isPaired returns true when both peerPWA* fields are set', () => {
    mockConfigFile({
      ...baseConfig,
      peerPWAPublicKey: 'peer-pk',
      peerPWASignPublicKey: 'peer-sign-pk',
    });
    expect(isPaired()).toBe(true);
  });

  it('isPaired returns false when only one peerPWA field is set', () => {
    mockConfigFile({
      ...baseConfig,
      peerPWAPublicKey: 'peer-pk',
      peerPWASignPublicKey: null,
    });
    expect(isPaired()).toBe(false);
  });

  it('pinPeerPWA writes both fields on an unpaired config', () => {
    mockConfigFile({
      ...baseConfig,
      peerPWAPublicKey: null,
      peerPWASignPublicKey: null,
    });
    const result = pinPeerPWA('peer-pk', 'peer-sign-pk');
    expect(result.peerPWAPublicKey).toBe('peer-pk');
    expect(result.peerPWASignPublicKey).toBe('peer-sign-pk');
    const saved = JSON.parse(
      mockedWriteFileSync.mock.calls[0]![1] as string,
    );
    expect(saved.peerPWAPublicKey).toBe('peer-pk');
    expect(saved.peerPWASignPublicKey).toBe('peer-sign-pk');
  });

  it('pinPeerPWA is idempotent when the same pair is already pinned', () => {
    mockConfigFile({
      ...baseConfig,
      peerPWAPublicKey: 'peer-pk',
      peerPWASignPublicKey: 'peer-sign-pk',
    });
    const result = pinPeerPWA('peer-pk', 'peer-sign-pk');
    expect(result.peerPWAPublicKey).toBe('peer-pk');
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('pinPeerPWA throws when a different pair is already pinned', () => {
    mockConfigFile({
      ...baseConfig,
      peerPWAPublicKey: 'peer-pk',
      peerPWASignPublicKey: 'peer-sign-pk',
    });
    expect(() => pinPeerPWA('other-pk', 'other-sign-pk')).toThrow(
      /already paired/i,
    );
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('pinPeerPWA throws when no config exists', () => {
    mockConfigFile(null);
    expect(() => pinPeerPWA('peer-pk', 'peer-sign-pk')).toThrow(
      /no config/i,
    );
  });

  it('clearPeerPWA nulls peerPWA*, rotates the full identity, and sets closed: true', () => {
    mockConfigFile({
      ...baseConfig,
      agentId: 'old-agent-id',
      peerPWAPublicKey: 'peer-pk',
      peerPWASignPublicKey: 'peer-sign-pk',
      keyPair: { publicKey: 'old-pk', secretKey: 'old-sk' },
      signKeyPair: { publicKey: 'old-sign-pk', secretKey: 'old-sign-sk' },
      closed: false,
    });
    const result = clearPeerPWA();
    expect(result.peerPWAPublicKey).toBeNull();
    expect(result.peerPWASignPublicKey).toBeNull();
    // Full identity rotation: agentId + X25519 + Ed25519 all fresh.
    expect(result.agentId).toBe('mock-agent-id');
    expect(result.keyPair).toEqual({ publicKey: 'mock-pk', secretKey: 'mock-sk' });
    expect(result.signKeyPair).toEqual({ publicKey: 'mock-sign-pk', secretKey: 'mock-sign-sk' });
    // Sticky closed flag persisted to disk so restart can't re-open TOFU.
    expect(result.closed).toBe(true);
    const saved = JSON.parse(
      mockedWriteFileSync.mock.calls[0]![1] as string,
    );
    expect(saved.peerPWAPublicKey).toBeNull();
    expect(saved.peerPWASignPublicKey).toBeNull();
    expect(saved.agentId).toBe('mock-agent-id');
    expect(saved.keyPair).toEqual({ publicKey: 'mock-pk', secretKey: 'mock-sk' });
    expect(saved.signKeyPair).toEqual({ publicKey: 'mock-sign-pk', secretKey: 'mock-sign-sk' });
    expect(saved.closed).toBe(true);
  });

  it('clearPeerPWA throws when no config exists', () => {
    mockConfigFile(null);
    expect(() => clearPeerPWA()).toThrow(/no config/i);
  });
});

describe('unlockPairingAndRotate', () => {
  it('clears peerPWA*, rotates identity, and lifts the closed gate', () => {
    mockConfigFile({
      ...baseConfig,
      agentId: 'old-agent-id',
      peerPWAPublicKey: null,
      peerPWASignPublicKey: null,
      keyPair: { publicKey: 'old-pk', secretKey: 'old-sk' },
      signKeyPair: { publicKey: 'old-sign-pk', secretKey: 'old-sign-sk' },
      closed: true,
    });
    const result = unlockPairingAndRotate();
    expect(result.peerPWAPublicKey).toBeNull();
    expect(result.peerPWASignPublicKey).toBeNull();
    expect(result.agentId).toBe('mock-agent-id');
    expect(result.keyPair).toEqual({ publicKey: 'mock-pk', secretKey: 'mock-sk' });
    expect(result.signKeyPair).toEqual({ publicKey: 'mock-sign-pk', secretKey: 'mock-sign-sk' });
    // Distinguishes it from clearPeerPWA: closed is cleared.
    expect(result.closed).toBe(false);
    const saved = JSON.parse(
      mockedWriteFileSync.mock.calls[0]![1] as string,
    );
    expect(saved.closed).toBe(false);
    expect(saved.agentId).toBe('mock-agent-id');
    expect(saved.keyPair).toEqual({ publicKey: 'mock-pk', secretKey: 'mock-sk' });
  });

  it('still rotates identity even when called on an already-unpaired/open config', () => {
    // User-driven re-pair from a paired state: every `quicksave pair`
    // invocation should come with a fresh identity, regardless of prior state.
    mockConfigFile({
      ...baseConfig,
      agentId: 'old-agent-id',
      peerPWAPublicKey: 'peer-pk',
      peerPWASignPublicKey: 'peer-sign-pk',
      closed: false,
    });
    const result = unlockPairingAndRotate();
    expect(result.agentId).toBe('mock-agent-id');
    expect(result.peerPWAPublicKey).toBeNull();
    expect(result.closed).toBe(false);
  });

  it('throws when no config exists', () => {
    mockConfigFile(null);
    expect(() => unlockPairingAndRotate()).toThrow(/no config/i);
  });
});
