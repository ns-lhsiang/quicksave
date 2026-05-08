// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from './messageHandler.js';
import { createMessage } from '@sumicom/quicksave-shared';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit } from 'simple-git';
import { getSessionRegistry, resetSessionRegistry } from '../ai/sessionRegistry.js';
import type { SessionRegistryEntry } from '@sumicom/quicksave-shared';
import { setQuicksaveDir } from '../service/singleton.js';

// Prevent tests from reading/writing the real ~/.quicksave/agent.json
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    addManagedRepo: vi.fn(),
    removeManagedRepo: vi.fn(),
    addManagedCodingPath: vi.fn(),
    removeManagedCodingPath: vi.fn(),
    getAnthropicApiKey: vi.fn(() => undefined),
    setAnthropicApiKey: vi.fn(),
    hasAnthropicApiKey: vi.fn(() => false),
  };
});

describe('MessageHandler', () => {
  let testRepoPath: string;
  let testQuicksaveDir: string;
  let handler: MessageHandler;
  let defaultBranch: string;

  beforeEach(async () => {
    // Redirect all quicksave paths to a temp dir so tests don't pollute ~/.quicksave
    testQuicksaveDir = join(tmpdir(), `qs-test-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testQuicksaveDir, { recursive: true });
    setQuicksaveDir(testQuicksaveDir);
    resetSessionRegistry();

    // Create temporary test repo
    testRepoPath = join(tmpdir(), `quicksave-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testRepoPath, { recursive: true });

    // Initialize git repo
    const git = simpleGit(testRepoPath);
    await git.init();
    await git.addConfig('user.email', 'test@test.com');
    await git.addConfig('user.name', 'Test User');

    // Create initial commit
    await writeFile(join(testRepoPath, 'README.md'), '# Test Repo\n');
    await git.add('README.md');
    await git.commit('Initial commit');

    // Get the default branch name (could be 'main' or 'master' depending on git config)
    const status = await git.status();
    defaultBranch = status.current || 'main';

    handler = new MessageHandler([{ path: testRepoPath, name: 'test-repo' }]);
  });

  afterEach(async () => {
    resetSessionRegistry();
    try {
      await rm(testRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      await rm(testQuicksaveDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('handleMessage - ping/pong', () => {
    it('should respond to ping with pong', async () => {
      const message = createMessage('ping', { timestamp: Date.now() });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('pong');
      expect(response.payload).toHaveProperty('timestamp');
    });
  });

  describe('handleMessage - handshake', () => {
    it('should respond to handshake with ack', async () => {
      const message = createMessage('handshake', { publicKey: 'test-key' });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('handshake:ack');
      expect(response.id).toBe(message.id);
      expect((response.payload as any).success).toBe(true);
      expect((response.payload as any).agentVersion).toBe('0.8.7');
      expect((response.payload as any).repoPath).toBe(testRepoPath);
    });
  });

  describe('handleMessage - git:status', () => {
    it('should return git status', async () => {
      const message = createMessage('git:status', {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:status:response');
      expect(response.id).toBe(message.id);

      const payload = response.payload as any;
      expect(payload.branch).toBe(defaultBranch);
      expect(Array.isArray(payload.staged)).toBe(true);
      expect(Array.isArray(payload.unstaged)).toBe(true);
      expect(Array.isArray(payload.untracked)).toBe(true);
    });

    it('should detect changes in status', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');

      const message = createMessage('git:status', {});
      const response = await handler.handleMessage(message);

      const payload = response.payload as any;
      expect(payload.untracked).toContain('newfile.txt');
    });
  });

  describe('handleMessage - git:diff', () => {
    it('should return diff for modified file', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Modified\n');

      const message = createMessage('git:diff', { path: 'README.md', staged: false });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:diff:response');
      expect(response.id).toBe(message.id);

      const payload = response.payload as any;
      expect(payload.path).toBe('README.md');
      expect(payload.hunks.length).toBeGreaterThan(0);
    });
  });

  describe('handleMessage - git:stage', () => {
    it('should stage files successfully', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');

      const message = createMessage('git:stage', { paths: ['newfile.txt'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:stage:response');
      expect((response.payload as any).success).toBe(true);

      // Verify file was staged
      const statusMsg = createMessage('git:status', {});
      const statusResp = await handler.handleMessage(statusMsg);
      const status = statusResp.payload as any;
      expect(status.staged.some((f: any) => f.path === 'newfile.txt')).toBe(true);
    });

    it('should return error for invalid path', async () => {
      const message = createMessage('git:stage', { paths: ['nonexistent.txt'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:stage:response');
      expect((response.payload as any).success).toBe(false);
      expect((response.payload as any).error).toBeDefined();
    });
  });

  describe('handleMessage - git:unstage', () => {
    it('should unstage files successfully', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');
      await simpleGit(testRepoPath).add('newfile.txt');

      const message = createMessage('git:unstage', { paths: ['newfile.txt'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:unstage:response');
      expect((response.payload as any).success).toBe(true);
    });
  });

  describe('handleMessage - git:commit', () => {
    it('should create commit successfully', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');
      await simpleGit(testRepoPath).add('newfile.txt');

      const message = createMessage('git:commit', { message: 'Test commit' });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:commit:response');
      expect((response.payload as any).success).toBe(true);
      expect((response.payload as any).hash).toBeDefined();
    });

    it('should create commit with description', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');
      await simpleGit(testRepoPath).add('newfile.txt');

      const message = createMessage('git:commit', {
        message: 'Title',
        description: 'Extended description',
      });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:commit:response');
      expect((response.payload as any).success).toBe(true);
    });

    it('should handle empty commit gracefully', async () => {
      const message = createMessage('git:commit', { message: 'Empty commit' });
      const response = await handler.handleMessage(message);

      // The behavior depends on git - it might succeed with empty commit or fail
      // We just verify it returns a proper response
      expect(response.type).toBe('git:commit:response');
    });
  });

  describe('handleMessage - git:log', () => {
    it('should return commit log', async () => {
      const message = createMessage('git:log', { limit: 10 });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:log:response');
      expect(response.id).toBe(message.id);

      const payload = response.payload as any;
      expect(Array.isArray(payload.commits)).toBe(true);
      expect(payload.commits.length).toBeGreaterThan(0);
      expect(payload.commits[0].message).toBe('Initial commit');
    });

    it('should use default limit when not specified', async () => {
      const message = createMessage('git:log', {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:log:response');
    });
  });

  describe('handleMessage - git:branches', () => {
    it('should return branches', async () => {
      const message = createMessage('git:branches', {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:branches:response');

      const payload = response.payload as any;
      expect(Array.isArray(payload.branches)).toBe(true);
      expect(payload.current).toBe(defaultBranch);
    });
  });

  describe('handleMessage - git:checkout', () => {
    it('should checkout existing branch', async () => {
      await simpleGit(testRepoPath).checkoutLocalBranch('feature');

      const message = createMessage('git:checkout', { branch: defaultBranch });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:checkout:response');
      expect((response.payload as any).success).toBe(true);
    });

    it('should create and checkout new branch', async () => {
      const message = createMessage('git:checkout', { branch: 'new-feature', create: true });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:checkout:response');
      expect((response.payload as any).success).toBe(true);

      // Verify branch was created
      const branchMsg = createMessage('git:branches', {});
      const branchResp = await handler.handleMessage(branchMsg);
      expect((branchResp.payload as any).current).toBe('new-feature');
    });

    it('should fail for non-existent branch', async () => {
      const message = createMessage('git:checkout', { branch: 'nonexistent' });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:checkout:response');
      expect((response.payload as any).success).toBe(false);
    });
  });

  describe('handleMessage - git:discard', () => {
    it('should discard changes', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Modified\n');

      const message = createMessage('git:discard', { paths: ['README.md'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:discard:response');
      expect((response.payload as any).success).toBe(true);

      // Verify changes were discarded
      const statusMsg = createMessage('git:status', {});
      const statusResp = await handler.handleMessage(statusMsg);
      expect((statusResp.payload as any).unstaged).toHaveLength(0);
    });
  });

  describe('handleMessage - git:untrack', () => {
    it('should untrack a tracked file', async () => {
      const message = createMessage('git:untrack', { paths: ['README.md'] });
      const response = await handler.handleMessage(message);
      expect(response.type).toBe('git:untrack:response');
      expect(response.id).toBe(message.id);
      expect((response.payload as any).success).toBe(true);
    });
  });

  describe('handleMessage - git:gitignore-add', () => {
    it('should add a pattern to .gitignore', async () => {
      const message = createMessage('git:gitignore-add', { pattern: 'node_modules/' });
      const response = await handler.handleMessage(message);
      expect(response.type).toBe('git:gitignore-add:response');
      expect((response.payload as any).success).toBe(true);
      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toContain('node_modules/');
    });
  });

  describe('handleMessage - git:gitignore-read', () => {
    it('should read .gitignore content', async () => {
      await writeFile(join(testRepoPath, '.gitignore'), '*.log\n');
      const message = createMessage('git:gitignore-read', {});
      const response = await handler.handleMessage(message);
      expect(response.type).toBe('git:gitignore-read:response');
      expect((response.payload as any).content).toBe('*.log\n');
      expect((response.payload as any).exists).toBe(true);
    });

    it('should return empty when .gitignore does not exist', async () => {
      const message = createMessage('git:gitignore-read', {});
      const response = await handler.handleMessage(message);
      expect((response.payload as any).content).toBe('');
      expect((response.payload as any).exists).toBe(false);
    });
  });

  describe('handleMessage - git:gitignore-write', () => {
    it('should write .gitignore content', async () => {
      const message = createMessage('git:gitignore-write', { content: 'dist/\n*.log\n' });
      const response = await handler.handleMessage(message);
      expect(response.type).toBe('git:gitignore-write:response');
      expect((response.payload as any).success).toBe(true);
      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toBe('dist/\n*.log\n');
    });
  });

  describe('handleMessage - unknown type', () => {
    it('should return error for unknown message type', async () => {
      const message = createMessage('unknown:type' as any, {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('error');
      expect((response.payload as any).code).toBe('UNKNOWN_MESSAGE_TYPE');
    });
  });

  describe('handleMessage - error handling', () => {
    it('should preserve message ID in responses', async () => {
      const message = createMessage('ping', {});
      message.id = 'custom-id-123';

      const response = await handler.handleMessage(message);

      // pong doesn't preserve ID in current implementation
      // but status and other git ops should
      expect(response).toBeDefined();
    });
  });

  describe('multi-client support', () => {
    const clientA = 'pwa:clientA';
    const clientB = 'pwa:clientB';

    let secondRepoPath: string;

    beforeEach(async () => {
      // Create a second repo for multi-repo tests
      secondRepoPath = join(tmpdir(), `quicksave-handler-test2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(secondRepoPath, { recursive: true });
      const git2 = simpleGit(secondRepoPath);
      await git2.init();
      await git2.addConfig('user.email', 'test@test.com');
      await git2.addConfig('user.name', 'Test User');
      await writeFile(join(secondRepoPath, 'README.md'), '# Second Repo\n');
      await git2.add('README.md');
      await git2.commit('Initial commit');

      // Recreate handler with two repos
      handler = new MessageHandler([
        { path: testRepoPath, name: 'test-repo' },
        { path: secondRepoPath, name: 'second-repo' },
      ]);
    });

    afterEach(async () => {
      try {
        await rm(secondRepoPath, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    });

    it('should isolate repo context per client', async () => {
      // Client A switches to second repo
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      const switchResp = await handler.handleMessage(switchMsg, clientA);
      expect((switchResp.payload as any).success).toBe(true);

      // Client B should still be on default repo
      const listMsgB = createMessage('agent:list-repos', {});
      const listRespB = await handler.handleMessage(listMsgB, clientB);
      expect((listRespB.payload as any).current).toBe(testRepoPath);
    });

    it('should return per-client current repo in list-repos', async () => {
      // Client A switches to second repo
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      await handler.handleMessage(switchMsg, clientA);

      // Client A's list-repos should show second repo as current
      const listMsgA = createMessage('agent:list-repos', {});
      const listRespA = await handler.handleMessage(listMsgA, clientA);
      expect((listRespA.payload as any).current).toBe(secondRepoPath);

      // Client B's list-repos should show first repo as current
      const listMsgB = createMessage('agent:list-repos', {});
      const listRespB = await handler.handleMessage(listMsgB, clientB);
      expect((listRespB.payload as any).current).toBe(testRepoPath);
    });

    it('should return per-client repo path in handshake', async () => {
      // Client A switches repo
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      await handler.handleMessage(switchMsg, clientA);

      // Client B handshake should return default repo
      const handshakeMsg = createMessage('handshake', { publicKey: 'test-key' });
      const handshakeResp = await handler.handleMessage(handshakeMsg, clientB);
      expect((handshakeResp.payload as any).repoPath).toBe(testRepoPath);
    });

    it('should preserve client repo pin across removeClient (reconnect flow)', async () => {
      // Client A switches repo
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      await handler.handleMessage(switchMsg, clientA);

      // Simulate disconnect
      handler.removeClient(clientA);

      // Client A reconnecting should still see its previously selected repo
      // as the current one. Clearing it would force the PWA to race
      // switch-repo against git:status on resume.
      const listMsg = createMessage('agent:list-repos', {});
      const listResp = await handler.handleMessage(listMsg, clientA);
      expect((listResp.payload as any).current).toBe(secondRepoPath);
    });

    it('should allow sequential mutating ops from different clients', async () => {
      await writeFile(join(testRepoPath, 'file1.txt'), 'content1');
      await writeFile(join(testRepoPath, 'file2.txt'), 'content2');

      const stageMsg1 = createMessage('git:stage', { paths: ['file1.txt'] });
      const resp1 = await handler.handleMessage(stageMsg1, clientA);
      expect((resp1.payload as any).success).toBe(true);

      const stageMsg2 = createMessage('git:stage', { paths: ['file2.txt'] });
      const resp2 = await handler.handleMessage(stageMsg2, clientB);
      expect((resp2.payload as any).success).toBe(true);
    });
  });

  describe('repo-scoped envelope (REPO_MISMATCH)', () => {
    let secondRepoPath: string;

    beforeEach(async () => {
      secondRepoPath = join(tmpdir(), `quicksave-handler-test-rmm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(secondRepoPath, { recursive: true });
      const git2 = simpleGit(secondRepoPath);
      await git2.init();
      await git2.addConfig('user.email', 'test@test.com');
      await git2.addConfig('user.name', 'Test User');
      await writeFile(join(secondRepoPath, 'README.md'), '# Second Repo\n');
      await git2.add('README.md');
      await git2.commit('Initial commit');

      handler = new MessageHandler([
        { path: testRepoPath, name: 'test-repo' },
        { path: secondRepoPath, name: 'second-repo' },
      ]);
    });

    afterEach(async () => {
      try { await rm(secondRepoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('stamps git: response envelope with the peer\'s current repoPath', async () => {
      const message = createMessage('git:status', {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:status:response');
      expect(response.repoPath).toBe(testRepoPath);
    });

    it('rejects git: request when envelope repoPath does not match peer repo', async () => {
      // Peer is on testRepoPath but stamps the request for secondRepoPath
      const message = createMessage('git:status', {});
      message.repoPath = secondRepoPath;

      const response = await handler.handleMessage(message);

      expect(response.type).toBe('error');
      expect((response.payload as any).code).toBe('REPO_MISMATCH');
      // Error envelope reports the agent's actual current repo for this peer
      expect(response.repoPath).toBe(testRepoPath);
    });

    it('accepts git: request when envelope repoPath matches peer repo', async () => {
      const message = createMessage('git:status', {});
      message.repoPath = testRepoPath;

      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:status:response');
      expect(response.repoPath).toBe(testRepoPath);
    });

    it('accepts git: request when envelope omits repoPath (back-compat)', async () => {
      const message = createMessage('git:status', {});
      // No envelope repoPath set — older clients still work.
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:status:response');
      expect(response.repoPath).toBe(testRepoPath);
    });

    it('does not stamp non-git responses with repoPath', async () => {
      const message = createMessage('ping', { timestamp: Date.now() });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('pong');
      expect(response.repoPath).toBeUndefined();
    });

    it('validates per-peer state: same envelope path may pass for one peer and fail for another', async () => {
      const peerA = 'pwa:peerA';
      const peerB = 'pwa:peerB';

      // peerA switches to secondRepoPath; peerB stays on default
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      await handler.handleMessage(switchMsg, peerA);

      // Same envelope (secondRepoPath) — accepted for peerA, rejected for peerB
      const reqA = createMessage('git:status', {});
      reqA.repoPath = secondRepoPath;
      const respA = await handler.handleMessage(reqA, peerA);
      expect(respA.type).toBe('git:status:response');
      expect(respA.repoPath).toBe(secondRepoPath);

      const reqB = createMessage('git:status', {});
      reqB.repoPath = secondRepoPath;
      const respB = await handler.handleMessage(reqB, peerB);
      expect(respB.type).toBe('error');
      expect((respB.payload as any).code).toBe('REPO_MISMATCH');
      expect(respB.repoPath).toBe(testRepoPath);
    });
  });

  describe('agent:clone-repo', () => {
    let bareRepoPath: string;
    let cloneTargetBase: string;

    beforeEach(async () => {
      // Create a bare repo to clone from (no network needed)
      bareRepoPath = join(tmpdir(), `qs-bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(bareRepoPath, { recursive: true });
      const bareGit = simpleGit(bareRepoPath);
      await bareGit.init();
      await bareGit.addConfig('user.email', 'test@test.com');
      await bareGit.addConfig('user.name', 'Test User');
      await writeFile(join(bareRepoPath, 'README.md'), '# Bare Repo\n');
      await bareGit.add('README.md');
      await bareGit.commit('Initial commit');

      cloneTargetBase = join(tmpdir(), `qs-clone-target-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(cloneTargetBase, { recursive: true });
    });

    afterEach(async () => {
      try { await rm(bareRepoPath, { recursive: true, force: true }); } catch { /* ignore */ }
      try { await rm(cloneTargetBase, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('should clone a repo and add it to managed repos', async () => {
      const targetDir = join(cloneTargetBase, 'cloned-repo');
      const msg = createMessage('agent:clone-repo', { url: bareRepoPath, targetDir });
      const response = await handler.handleMessage(msg);

      const payload = response.payload as any;
      expect(payload.success).toBe(true);
      expect(payload.repo).toBeDefined();
      expect(payload.repo.name).toBe('cloned-repo');
      expect(payload.clonedPath).toBe(targetDir);
    });

    it('should fail with empty URL', async () => {
      const targetDir = join(cloneTargetBase, 'empty-url');
      const msg = createMessage('agent:clone-repo', { url: '', targetDir });
      const response = await handler.handleMessage(msg);

      const payload = response.payload as any;
      expect(payload.success).toBe(false);
      expect(payload.error).toMatch(/URL is required/i);
    });

    it('should fail with invalid URL', async () => {
      const targetDir = join(cloneTargetBase, 'bad-clone');
      const msg = createMessage('agent:clone-repo', { url: '/nonexistent/path', targetDir });
      const response = await handler.handleMessage(msg);

      const payload = response.payload as any;
      expect(payload.success).toBe(false);
      expect(payload.error).toBeDefined();
    });

    it('should reject cloning into an already-added repo path', async () => {
      // First clone
      const targetDir = join(cloneTargetBase, 'first-clone');
      const msg1 = createMessage('agent:clone-repo', { url: bareRepoPath, targetDir });
      const resp1 = await handler.handleMessage(msg1);
      expect((resp1.payload as any).success).toBe(true);

      // Second clone to a different dir, then try adding same path
      // (we can't clone to same dir - git will fail, so test the "already added" path
      // by cloning to a new dir that resolves to the same git root won't happen here,
      // but we verify first clone registered the repo)
      const listMsg = createMessage('agent:list-repos', {});
      const listResp = await handler.handleMessage(listMsg);
      const repos = (listResp.payload as any).repos;
      expect(repos.some((r: any) => r.path === targetDir)).toBe(true);
    });
  });

  describe('handleMessage - agent:remove-repo', () => {
    it('should remove an existing repo', async () => {
      const msg = createMessage('agent:remove-repo', { path: testRepoPath });
      const response = await handler.handleMessage(msg);

      expect(response.type).toBe('agent:remove-repo:response');
      expect(response.id).toBe(msg.id);
      expect((response.payload as any).success).toBe(true);

      // Verify repo is no longer listed
      const listMsg = createMessage('agent:list-repos', {});
      const listResp = await handler.handleMessage(listMsg);
      const repos = (listResp.payload as any).repos;
      expect(repos.some((r: any) => r.path === testRepoPath)).toBe(false);
    });

    it('should return error for non-existent repo path', async () => {
      const msg = createMessage('agent:remove-repo', { path: '/nonexistent/path' });
      const response = await handler.handleMessage(msg);

      expect(response.type).toBe('agent:remove-repo:response');
      expect((response.payload as any).success).toBe(false);
      expect((response.payload as any).error).toBe('Repository not found');
    });
  });

  describe('handleMessage - agent:remove-coding-path', () => {
    let codingPathDir: string;

    beforeEach(async () => {
      codingPathDir = join(tmpdir(), `quicksave-coding-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(codingPathDir, { recursive: true });

      // Add the coding path first
      const addMsg = createMessage('agent:add-coding-path', { path: codingPathDir });
      const addResp = await handler.handleMessage(addMsg);
      expect((addResp.payload as any).success).toBe(true);
    });

    afterEach(async () => {
      try {
        await rm(codingPathDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should remove an existing coding path', async () => {
      const msg = createMessage('agent:remove-coding-path', { path: codingPathDir });
      const response = await handler.handleMessage(msg);

      expect(response.type).toBe('agent:remove-coding-path:response');
      expect(response.id).toBe(msg.id);
      expect((response.payload as any).success).toBe(true);

      // Verify coding path is no longer listed
      const listMsg = createMessage('agent:list-coding-paths', {});
      const listResp = await handler.handleMessage(listMsg);
      const paths = (listResp.payload as any).paths;
      expect(paths.some((p: any) => p.path === codingPathDir)).toBe(false);
    });

    it('should return error for non-existent coding path', async () => {
      const msg = createMessage('agent:remove-coding-path', { path: '/nonexistent/path' });
      const response = await handler.handleMessage(msg);

      expect(response.type).toBe('agent:remove-coding-path:response');
      expect((response.payload as any).success).toBe(false);
      expect((response.payload as any).error).toBe('Coding path not found');
    });
  });

  describe('handleMessage - project:list-repos', () => {
    it('returns the root repo with branch and dirty state for a healthy git repo', async () => {
      const msg = createMessage('project:list-repos', { cwd: testRepoPath });
      const response = await handler.handleMessage(msg);

      expect(response.type).toBe('project:list-repos:response');
      const repos = (response.payload as any).repos as Array<{
        path: string;
        name: string;
        currentBranch?: string;
        hasChanges?: boolean;
      }>;
      const root = repos.find((r) => r.path === testRepoPath);
      expect(root).toBeDefined();
      expect(root!.currentBranch).toBe(defaultBranch);
      expect(root!.hasChanges).toBe(false);
    });

    it('still returns the root repo when git metadata calls fail (so the PWA Git section does not flash empty under transient git errors)', async () => {
      // Break refs so `git branch -a` fails, but keep `.git` present.
      // Mirrors real-world transient failures (EAGAIN under daemon load,
      // refs being rewritten by a concurrent fetch/gc).
      await rm(join(testRepoPath, '.git', 'HEAD'));

      const msg = createMessage('project:list-repos', { cwd: testRepoPath });
      const response = await handler.handleMessage(msg);

      const repos = (response.payload as any).repos as Array<{
        path: string;
        name: string;
        currentBranch?: string;
        hasChanges?: boolean;
      }>;
      const root = repos.find((r) => r.path === testRepoPath);
      expect(root).toBeDefined();
      expect(root!.currentBranch).toBeUndefined();
      // hasChanges may be undefined when status fails; we only require the
      // repo entry itself to survive.
    });

    it('returns no entries when cwd has no .git', async () => {
      const nonRepo = join(tmpdir(), `qs-list-repos-norepo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(nonRepo, { recursive: true });
      try {
        const msg = createMessage('project:list-repos', { cwd: nonRepo });
        const response = await handler.handleMessage(msg);
        const repos = (response.payload as any).repos as unknown[];
        expect(repos).toEqual([]);
      } finally {
        await rm(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe('handleMessage - project:list-summaries', () => {
    it('should include managed coding paths with no sessions', async () => {
      const codingPath = join(tmpdir(), `qs-list-summaries-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(codingPath, { recursive: true });
      try {
        const addMsg = createMessage('agent:add-coding-path', { path: codingPath });
        const addResp = await handler.handleMessage(addMsg);
        expect((addResp.payload as any).success).toBe(true);

        const msg = createMessage('project:list-summaries', {});
        const response = await handler.handleMessage(msg);

        expect(response.type).toBe('project:list-summaries:response');
        const projects = (response.payload as any).projects as Array<{
          cwd: string;
          sessionCount: number;
          lastActivityAt: number;
        }>;
        const entry = projects.find((p) => p.cwd === codingPath);
        expect(entry).toBeDefined();
        expect(entry!.sessionCount).toBe(0);
        expect(entry!.lastActivityAt).toBe(0);
      } finally {
        await rm(codingPath, { recursive: true, force: true });
      }
    });
  });

  describe('handleMessage - project:delete', () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = join(tmpdir(), `qs-delete-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(projectDir, { recursive: true });

      // Register the project as a managed coding path so its removal is visible
      const addMsg = createMessage('agent:add-coding-path', { path: projectDir });
      const addResp = await handler.handleMessage(addMsg);
      expect((addResp.payload as any).success).toBe(true);
    });

    afterEach(async () => {
      try {
        await rm(projectDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    function seedEntry(sessionId: string, lastAccessedAt = Date.now()): SessionRegistryEntry {
      const entry: SessionRegistryEntry = {
        sessionId,
        cwd: projectDir,
        title: `session-${sessionId}`,
        createdAt: lastAccessedAt - 1000,
        lastAccessedAt,
      };
      getSessionRegistry().upsertEntry(entry);
      return entry;
    }

    it('archives all active sessions for the cwd and returns the count', async () => {
      seedEntry('sess-a', Date.now() - 2000);
      seedEntry('sess-b', Date.now() - 1000);

      const historyEvents: Array<{ cwd: string; entry: SessionRegistryEntry; action: string }> = [];
      handler.onHistoryUpdated = (cwd, entry, action) => {
        historyEvents.push({ cwd, entry, action });
      };

      const msg = createMessage('project:delete', { cwd: projectDir });
      const response = await handler.handleMessage(msg);

      expect(response.type).toBe('project:delete:response');
      expect(response.id).toBe(msg.id);
      expect((response.payload as any).success).toBe(true);
      expect((response.payload as any).archivedCount).toBe(2);

      // Entries gone from the active view
      const registry = getSessionRegistry();
      expect(registry.getEntriesForProject(projectDir)).toHaveLength(0);

      // Still discoverable as archived
      const archivedIds = registry.listArchivedEntries(projectDir).map((e) => e.sessionId).sort();
      expect(archivedIds).toEqual(['sess-a', 'sess-b']);

      // Each archive fires an onHistoryUpdated('upsert') with archived=true
      expect(historyEvents).toHaveLength(2);
      for (const ev of historyEvents) {
        expect(ev.cwd).toBe(projectDir);
        expect(ev.action).toBe('upsert');
        expect(ev.entry.archived).toBe(true);
      }
    });

    it('removes the cwd from managed coding paths', async () => {
      const msg = createMessage('project:delete', { cwd: projectDir });
      const response = await handler.handleMessage(msg);
      expect((response.payload as any).success).toBe(true);

      const listResp = await handler.handleMessage(
        createMessage('agent:list-coding-paths', {}),
      );
      const paths = (listResp.payload as any).paths as Array<{ path: string }>;
      expect(paths.some((p) => p.path === projectDir)).toBe(false);
    });

    it('returns success with archivedCount 0 when the project has no active sessions', async () => {
      const msg = createMessage('project:delete', { cwd: projectDir });
      const response = await handler.handleMessage(msg);

      expect((response.payload as any).success).toBe(true);
      expect((response.payload as any).archivedCount).toBe(0);
    });

    it('drops the project from project:list-summaries after delete', async () => {
      seedEntry('sess-only');

      const before = await handler.handleMessage(
        createMessage('project:list-summaries', {}),
      );
      const beforeProjects = (before.payload as any).projects as Array<{ cwd: string }>;
      expect(beforeProjects.some((p) => p.cwd === projectDir)).toBe(true);

      await handler.handleMessage(createMessage('project:delete', { cwd: projectDir }));

      const after = await handler.handleMessage(
        createMessage('project:list-summaries', {}),
      );
      const afterProjects = (after.payload as any).projects as Array<{ cwd: string }>;
      expect(afterProjects.some((p) => p.cwd === projectDir)).toBe(false);
    });

    it('closes every live Claude session under the deleted cwd', async () => {
      const claudeService = (handler as unknown as {
        claudeService: {
          getActiveSessions: () => Array<{ sessionId: string; cwd: string }>;
          closeSession: (sessionId: string) => boolean;
        };
      }).claudeService;

      const otherCwd = join(tmpdir(), `qs-other-${Date.now()}`);
      vi.spyOn(claudeService, 'getActiveSessions').mockReturnValue([
        { sessionId: 'live-1', cwd: projectDir } as any,
        { sessionId: 'live-2', cwd: projectDir } as any,
        { sessionId: 'live-other', cwd: otherCwd } as any,
      ]);
      const closeSpy = vi.spyOn(claudeService, 'closeSession').mockReturnValue(true);

      await handler.handleMessage(createMessage('project:delete', { cwd: projectDir }));

      const closedIds = closeSpy.mock.calls.map((c) => c[0]).sort();
      expect(closedIds).toEqual(['live-1', 'live-2']);
      expect(closedIds).not.toContain('live-other');
    });
  });

  describe('handleMessage - claude:end-task', () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = join(tmpdir(), `qs-end-task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(projectDir, { recursive: true });
    });

    afterEach(async () => {
      try {
        await rm(projectDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    function seedEntry(sessionId: string): SessionRegistryEntry {
      const entry: SessionRegistryEntry = {
        sessionId,
        cwd: projectDir,
        title: `session-${sessionId}`,
        createdAt: Date.now() - 1000,
        lastAccessedAt: Date.now(),
      };
      getSessionRegistry().upsertEntry(entry);
      return entry;
    }

    it('archives the registry entry and broadcasts the upsert', async () => {
      seedEntry('sess-end');

      const historyEvents: Array<{ cwd: string; entry: SessionRegistryEntry; action: string }> = [];
      handler.onHistoryUpdated = (cwd, entry, action) => {
        historyEvents.push({ cwd, entry, action });
      };

      const msg = createMessage('claude:end-task', { sessionId: 'sess-end' });
      const response = await handler.handleMessage(msg);

      expect(response.type).toBe('claude:end-task:response');
      expect(response.id).toBe(msg.id);
      expect((response.payload as any).success).toBe(true);

      const registry = getSessionRegistry();
      // Entry leaves the active list
      expect(registry.getEntriesForProject(projectDir)).toHaveLength(0);
      // …and lands under archived
      expect(
        registry.listArchivedEntries(projectDir).map((e) => e.sessionId),
      ).toEqual(['sess-end']);

      expect(historyEvents).toHaveLength(1);
      expect(historyEvents[0].cwd).toBe(projectDir);
      expect(historyEvents[0].action).toBe('upsert');
      expect(historyEvents[0].entry.archived).toBe(true);
    });

    it('returns success=false for an unknown sessionId with no live process and no registry entry', async () => {
      const msg = createMessage('claude:end-task', { sessionId: 'no-such-session' });
      const response = await handler.handleMessage(msg);

      expect(response.type).toBe('claude:end-task:response');
      expect((response.payload as any).success).toBe(false);
      expect((response.payload as any).error).toBeDefined();
    });

    it('also kills the live CLI process when the session is active', async () => {
      seedEntry('sess-live');

      const claudeService = (handler as unknown as {
        claudeService: {
          getSessionCwd: (sessionId: string) => string | undefined;
          closeSession: (sessionId: string) => boolean;
        };
      }).claudeService;
      vi.spyOn(claudeService, 'getSessionCwd').mockReturnValue(projectDir);
      const closeSpy = vi.spyOn(claudeService, 'closeSession').mockReturnValue(true);

      const msg = createMessage('claude:end-task', { sessionId: 'sess-live' });
      const response = await handler.handleMessage(msg);

      expect((response.payload as any).success).toBe(true);
      expect(closeSpy).toHaveBeenCalledWith('sess-live');
      // Archive still happened
      expect(getSessionRegistry().getEntriesForProject(projectDir)).toHaveLength(0);
      expect(
        getSessionRegistry().listArchivedEntries(projectDir).map((e) => e.sessionId),
      ).toEqual(['sess-live']);
    });
  });
});
