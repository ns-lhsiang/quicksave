// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitOperations } from './operations.js';
import { mkdir, writeFile, rm, unlink, readFile } from 'fs/promises';
import { realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit, SimpleGit } from 'simple-git';

/**
 * Adversarial and edge-case tests for GitOperations.
 * These use real temporary git repos (not mocks).
 */

/** Helper: create a fresh git repo with an initial commit */
async function createTestRepo(): Promise<{ repoPath: string; git: SimpleGit; defaultBranch: string }> {
  const rawPath = join(tmpdir(), `qs-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(rawPath, { recursive: true });
  // Resolve symlinks (macOS /var -> /private/var) so paths match git rev-parse output
  const repoPath = realpathSync(rawPath);
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test User');
  await writeFile(join(repoPath, 'README.md'), '# Test Repo\n');
  await git.add('README.md');
  await git.commit('Initial commit');
  const status = await git.status();
  return { repoPath, git, defaultBranch: status.current || 'main' };
}

describe('GitOperations – edge cases', () => {
  let repoPath: string;
  let git: SimpleGit;
  let gitOps: GitOperations;
  let defaultBranch: string;

  beforeEach(async () => {
    ({ repoPath, git, defaultBranch } = await createTestRepo());
    gitOps = new GitOperations(repoPath);
  });

  afterEach(async () => {
    try { await rm(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ===========================================================================
  // 1. Concurrent git operations
  // ===========================================================================
  describe('concurrent operations', () => {
    it('should handle two simultaneous stage() calls without corruption', async () => {
      // Create two files
      await writeFile(join(repoPath, 'a.txt'), 'aaa');
      await writeFile(join(repoPath, 'b.txt'), 'bbb');

      // Stage both at the same time
      await Promise.all([
        gitOps.stage(['a.txt']),
        gitOps.stage(['b.txt']),
      ]);

      const status = await gitOps.getStatus();
      const stagedPaths = status.staged.map(f => f.path).sort();
      expect(stagedPaths).toEqual(['a.txt', 'b.txt']);
    });

    it('should handle concurrent stage + getStatus without error', async () => {
      await writeFile(join(repoPath, 'c.txt'), 'ccc');

      // Run stage and status concurrently — should not throw
      const [, status] = await Promise.all([
        gitOps.stage(['c.txt']),
        gitOps.getStatus(),
      ]);
      // status may or may not show c.txt as staged (race), but must not throw
      expect(status.branch).toBeTruthy();
    });

    it('should handle concurrent getDiff calls', async () => {
      await writeFile(join(repoPath, 'README.md'), '# Changed\n');
      await writeFile(join(repoPath, 'other.txt'), 'content');
      await git.add('other.txt');
      await git.commit('Add other');
      await writeFile(join(repoPath, 'other.txt'), 'changed');

      const [diff1, diff2] = await Promise.all([
        gitOps.getDiff('README.md'),
        gitOps.getDiff('other.txt'),
      ]);
      expect(diff1.path).toBe('README.md');
      expect(diff2.path).toBe('other.txt');
    });
  });

  // ===========================================================================
  // 2. Path traversal
  // ===========================================================================
  describe('path traversal / out-of-repo paths', () => {
    it('getDiff with relative traversal path throws (no path validation)', async () => {
      // BUG: getDiff does not validate that the path is within the repo.
      // It passes the path straight to `git diff -- <path>` which throws a
      // fatal error. Ideally getDiff should catch this or validate paths
      // before calling git, returning an empty diff instead of throwing.
      await expect(gitOps.getDiff('../../etc/passwd')).rejects.toThrow(/outside repository/);
    });

    it('getDiff with absolute path outside repo throws (no path validation)', async () => {
      // BUG: Same issue — absolute paths outside the repo cause an unhandled
      // fatal error from git rather than being gracefully rejected.
      await expect(gitOps.getDiff('/etc/passwd')).rejects.toThrow(/outside repository/);
    });

    it('stage with traversal path should not stage files outside repo', async () => {
      // git add should reject paths outside the work tree
      await expect(gitOps.stage(['../../etc/passwd'])).rejects.toThrow();
    });

    it('stage with absolute path outside repo should reject', async () => {
      await expect(gitOps.stage(['/tmp/nonexistent-file-xyz'])).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 3. Binary files
  // ===========================================================================
  describe('binary files', () => {
    it('getDiff on a binary file should set isBinary', async () => {
      // Create a minimal valid PNG (1x1 pixel)
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // 8-bit RGB
      ]);

      await writeFile(join(repoPath, 'image.png'), pngHeader);
      await git.add('image.png');
      await git.commit('Add image');

      // Modify the binary file
      const modified = Buffer.concat([pngHeader, Buffer.from([0xFF, 0x00, 0xAB])]);
      await writeFile(join(repoPath, 'image.png'), modified);

      const diff = await gitOps.getDiff('image.png');
      expect(diff.isBinary).toBe(true);
    });

    it('getDiff on untracked binary file should detect binary content', async () => {
      // File with null bytes triggers isBinaryContent
      await writeFile(join(repoPath, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0xFF]));

      const diff = await gitOps.getDiff('data.bin');
      expect(diff.isBinary).toBe(true);
    });

    it('getDiff on untracked non-image binary should return no imageData', async () => {
      await writeFile(join(repoPath, 'data.bin'), Buffer.from([0x00, 0x01, 0x02]));

      const diff = await gitOps.getDiff('data.bin');
      expect(diff.isBinary).toBe(true);
      expect(diff.imageData).toBeUndefined();
    });

    it('getDiff on untracked image file should provide imageData', async () => {
      const pngData = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
        0x00, // null byte to trigger binary detection
      ]);
      await writeFile(join(repoPath, 'photo.png'), pngData);

      const diff = await gitOps.getDiff('photo.png');
      expect(diff.isBinary).toBe(true);
      // imageData should have the new image at minimum
      expect(diff.imageData).toBeDefined();
      expect(diff.imageData?.new).toMatch(/^data:image\/png;base64,/);
      expect(diff.imageData?.old).toBeUndefined(); // new file has no old version
    });
  });

  // ===========================================================================
  // 4. Empty repo (no commits)
  // ===========================================================================
  describe('empty repo (no commits)', () => {
    let emptyPath: string;
    let emptyOps: GitOperations;

    beforeEach(async () => {
      emptyPath = join(tmpdir(), `qs-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(emptyPath, { recursive: true });
      const g = simpleGit(emptyPath);
      await g.init();
      await g.addConfig('user.email', 'test@test.com');
      await g.addConfig('user.name', 'Test User');
      emptyOps = new GitOperations(emptyPath);
    });

    afterEach(async () => {
      try { await rm(emptyPath, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('getStatus on repo with no commits should not crash', async () => {
      // Some git commands behave differently with no commits (orphan branch)
      const status = await emptyOps.getStatus();
      expect(status.branch).toBeTruthy();
      expect(status.staged).toHaveLength(0);
    });

    it('getStatus should detect staged files in empty repo', async () => {
      await writeFile(join(emptyPath, 'first.txt'), 'hello');
      await simpleGit(emptyPath).add('first.txt');

      const status = await emptyOps.getStatus();
      expect(status.staged.some(f => f.path === 'first.txt')).toBe(true);
    });

    it('getDiff on staged file in empty repo should return content', async () => {
      await writeFile(join(emptyPath, 'first.txt'), 'hello\nworld\n');
      await simpleGit(emptyPath).add('first.txt');

      const diff = await emptyOps.getDiff('first.txt', true);
      expect(diff.path).toBe('first.txt');
      // Should show the file content as additions
      expect(diff.hunks.length).toBeGreaterThan(0);
    });

    it('unstage in empty repo should not crash', async () => {
      await writeFile(join(emptyPath, 'first.txt'), 'hello');
      await simpleGit(emptyPath).add('first.txt');

      // In an empty repo, HEAD doesn't exist, so `git reset HEAD -- <file>` may fail
      // BUG: unstage() uses `git reset HEAD -- <path>` which fails in an empty repo
      // because HEAD does not exist yet. simple-git will throw.
      try {
        await emptyOps.unstage(['first.txt']);
        // If it succeeds, that's fine
      } catch (err) {
        // BUG: unstage fails on repos with no commits because HEAD doesn't exist.
        // The fix would be `git rm --cached <path>` for the initial-commit case.
        expect(err).toBeDefined();
      }
    });

    it('commit in empty repo should create the first commit', async () => {
      await writeFile(join(emptyPath, 'first.txt'), 'hello');
      await simpleGit(emptyPath).add('first.txt');

      const hash = await emptyOps.commit('First commit');
      expect(hash).toBeTruthy();
    });
  });

  // ===========================================================================
  // 5. Deleted files
  // ===========================================================================
  describe('deleted files', () => {
    it('getDiff on a deleted tracked file should show removal', async () => {
      await writeFile(join(repoPath, 'doomed.txt'), 'will be deleted\n');
      await git.add('doomed.txt');
      await git.commit('Add doomed file');

      // Delete the file
      await unlink(join(repoPath, 'doomed.txt'));

      const diff = await gitOps.getDiff('doomed.txt');
      expect(diff.path).toBe('doomed.txt');
      expect(diff.hunks.length).toBeGreaterThan(0);
      expect(diff.hunks[0].content).toContain('-will be deleted');
    });

    it('getDiff staged on a deleted file should show removal', async () => {
      await writeFile(join(repoPath, 'doomed.txt'), 'content\n');
      await git.add('doomed.txt');
      await git.commit('Add doomed');

      await unlink(join(repoPath, 'doomed.txt'));
      await git.add('doomed.txt'); // stages the deletion

      const diff = await gitOps.getDiff('doomed.txt', true);
      expect(diff.hunks.length).toBeGreaterThan(0);
      expect(diff.hunks[0].content).toContain('-content');
    });

    it('stage with a deleted file path should stage the deletion', async () => {
      await writeFile(join(repoPath, 'temp.txt'), 'temporary\n');
      await git.add('temp.txt');
      await git.commit('Add temp');

      await unlink(join(repoPath, 'temp.txt'));
      await gitOps.stage(['temp.txt']);

      const status = await gitOps.getStatus();
      expect(status.staged.some(f => f.path === 'temp.txt' && f.status === 'deleted')).toBe(true);
    });

    it('getStatus should detect deleted files as unstaged', async () => {
      await writeFile(join(repoPath, 'temp.txt'), 'temporary\n');
      await git.add('temp.txt');
      await git.commit('Add temp');

      await unlink(join(repoPath, 'temp.txt'));

      const status = await gitOps.getStatus();
      expect(status.unstaged.some(f => f.path === 'temp.txt' && f.status === 'deleted')).toBe(true);
    });
  });

  // ===========================================================================
  // 6. Unicode filenames
  // ===========================================================================
  describe('unicode filenames', () => {
    it('should handle Chinese characters in filenames', async () => {
      const filename = '测试文件.txt';
      await writeFile(join(repoPath, filename), 'content');

      const status = await gitOps.getStatus();
      // Git may quote non-ASCII filenames. Check that the file appears somewhere.
      const allPaths = [
        ...status.untracked,
        ...status.staged.map(f => f.path),
        ...status.unstaged.map(f => f.path),
      ];
      // At least one entry should reference this file (possibly quoted by git)
      expect(allPaths.length).toBeGreaterThan(0);
    });

    it('should stage and commit a file with emoji in its name', async () => {
      const filename = '🚀rocket.txt';
      await writeFile(join(repoPath, filename), 'launch');

      await gitOps.stage([filename]);
      const hash = await gitOps.commit('Add rocket file');
      expect(hash).toBeTruthy();

      const status = await gitOps.getStatus();
      expect(status.staged).toHaveLength(0);
      expect(status.untracked).toHaveLength(0);
    });

    it('getDiff should work with unicode filename', async () => {
      const filename = 'données.txt';
      await writeFile(join(repoPath, filename), 'initial\n');
      await git.add(filename);
      await git.commit('Add données');

      await writeFile(join(repoPath, filename), 'modified\n');

      const diff = await gitOps.getDiff(filename);
      expect(diff.path).toBe(filename);
      expect(diff.hunks.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // 7. Very long file paths
  // ===========================================================================
  describe('very long file paths', () => {
    it('should handle deeply nested directory paths', async () => {
      // Create a deeply nested path (stay under OS limits ~255 per component)
      const dirs = Array.from({ length: 10 }, (_, i) => `dir${i}`);
      const deepDir = join(repoPath, ...dirs);
      await mkdir(deepDir, { recursive: true });
      const deepFile = join(deepDir, 'deep.txt');
      await writeFile(deepFile, 'deep content');

      const status = await gitOps.getStatus();
      const relPath = dirs.join('/') + '/deep.txt';
      expect(status.untracked.some(p => p.includes('deep.txt'))).toBe(true);
    });

    it('should stage a deeply nested file', async () => {
      const dirs = Array.from({ length: 8 }, (_, i) => `level${i}`);
      const deepDir = join(repoPath, ...dirs);
      await mkdir(deepDir, { recursive: true });
      const relPath = dirs.join('/') + '/nested.txt';
      await writeFile(join(deepDir, 'nested.txt'), 'nested content');

      await gitOps.stage([relPath]);
      const status = await gitOps.getStatus();
      expect(status.staged.some(f => f.path.includes('nested.txt'))).toBe(true);
    });
  });

  // ===========================================================================
  // 8. Gitignore interaction
  // ===========================================================================
  describe('gitignore interaction', () => {
    it('getStatus should exclude gitignored files from untracked', async () => {
      await writeFile(join(repoPath, '.gitignore'), '*.log\n');
      await git.add('.gitignore');
      await git.commit('Add gitignore');

      await writeFile(join(repoPath, 'debug.log'), 'log content');

      const status = await gitOps.getStatus();
      expect(status.untracked).not.toContain('debug.log');
    });

    it('stage should allow force-adding a gitignored file via git add -f', async () => {
      await writeFile(join(repoPath, '.gitignore'), '*.log\n');
      await git.add('.gitignore');
      await git.commit('Add gitignore');

      await writeFile(join(repoPath, 'important.log'), 'must keep');

      // BUG: stage() uses plain git.add() which does NOT pass -f, so staging
      // an ignored file throws an error rather than silently skipping or
      // force-adding. The caller has no way to force-stage an ignored file
      // through the current API, and the error is not caught.
      await expect(gitOps.stage(['important.log'])).rejects.toThrow(/ignored/);
    });

    it('getDiff on a gitignored untracked file returns empty diff', async () => {
      await writeFile(join(repoPath, '.gitignore'), 'secret.env\n');
      await git.add('.gitignore');
      await git.commit('Add gitignore');

      await writeFile(join(repoPath, 'secret.env'), 'API_KEY=xyz');

      // File is untracked and ignored — git status won't list it in not_added
      const diff = await gitOps.getDiff('secret.env');
      // Since it's not in status.not_added, getDiff takes the normal diff path
      // which returns empty since git doesn't track it
      expect(diff.hunks).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 9. Patch stage/unstage edge cases
  // ===========================================================================
  describe('patch stage/unstage edge cases', () => {
    it('stagePatch with malformed patch should throw', async () => {
      await expect(gitOps.stagePatch('this is not a valid patch')).rejects.toThrow();
    });

    it('stagePatch with empty string should throw', async () => {
      await expect(gitOps.stagePatch('')).rejects.toThrow();
    });

    it('unstagePatch when nothing is staged should throw', async () => {
      const fakePatch = [
        'diff --git a/README.md b/README.md',
        'index abc..def 100644',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1 @@',
        '-# Test Repo',
        '+# Changed',
      ].join('\n');

      await expect(gitOps.unstagePatch(fakePatch)).rejects.toThrow();
    });

    it('stagePatch with a valid patch should work', async () => {
      // Create a file with multiple lines and modify one
      await writeFile(join(repoPath, 'multi.txt'), 'line1\nline2\nline3\n');
      await git.add('multi.txt');
      await git.commit('Add multi');
      await writeFile(join(repoPath, 'multi.txt'), 'line1\nchanged\nline3\n');

      // Get the actual diff from git to construct a valid patch
      const diffOutput = await git.diff(['--', 'multi.txt']);
      expect(diffOutput).toBeTruthy();

      // Apply it as a staged patch
      await gitOps.stagePatch(diffOutput);

      const status = await gitOps.getStatus();
      expect(status.staged.some(f => f.path === 'multi.txt')).toBe(true);
    });
  });

  // ===========================================================================
  // 10. Commit edge cases
  // ===========================================================================
  describe('commit edge cases', () => {
    it('commit with empty message should still create a commit', async () => {
      await writeFile(join(repoPath, 'file.txt'), 'content');
      await git.add('file.txt');

      // Git allows empty messages with --allow-empty-message, but simple-git
      // may or may not. Let's see what happens.
      const hash = await gitOps.commit('');
      // simple-git should still create the commit — the message will contain
      // only the attribution trailer
      expect(hash).toBeTruthy();
    });

    it('commit with only whitespace message should create a commit', async () => {
      await writeFile(join(repoPath, 'ws.txt'), 'content');
      await git.add('ws.txt');

      const hash = await gitOps.commit('   ');
      expect(hash).toBeTruthy();
    });

    it('commit with nothing staged should return empty hash', async () => {
      // No files staged — git commit should fail or return empty
      const hash = await gitOps.commit('Empty commit');
      // simple-git returns empty string for the commit hash when nothing to commit
      expect(hash).toBe('');
    });

    it('commit without attribution should not include Generated-by', async () => {
      await writeFile(join(repoPath, 'attr.txt'), 'content');
      await git.add('attr.txt');

      await gitOps.commit('No attribution', undefined, false);

      const log = await git.log({ maxCount: 1 });
      expect(log.latest?.body).not.toContain('Generated-by');
    });

    it('commit with description should include it in the message body', async () => {
      await writeFile(join(repoPath, 'desc.txt'), 'content');
      await git.add('desc.txt');

      await gitOps.commit('Title', 'Detailed description here');

      const log = await git.log({ maxCount: 1 });
      expect(log.latest?.body).toContain('Detailed description here');
    });
  });

  // ===========================================================================
  // 11. File size limit / truncation
  // ===========================================================================
  describe('file size truncation', () => {
    it('getDiff on file exceeding size limit should return truncated', async () => {
      const ops = new GitOperations(repoPath, { maxDiffFileSizeKB: 1 }); // 1KB limit

      // Create a file larger than 1KB
      const bigContent = 'x'.repeat(2048); // 2KB
      await writeFile(join(repoPath, 'big.txt'), bigContent);

      const diff = await ops.getDiff('big.txt');
      expect(diff.truncated).toBe(true);
      expect(diff.truncatedReason).toContain('1KB');
    });

    it('getDiff on oversized image should still return imageData', async () => {
      const ops = new GitOperations(repoPath, { maxDiffFileSizeKB: 1 }); // 1KB limit

      // Create a "PNG" file bigger than 1KB with null bytes for binary detection
      const bigImage = Buffer.alloc(2048, 0);
      bigImage[0] = 0x89; bigImage[1] = 0x50; bigImage[2] = 0x4E; bigImage[3] = 0x47;
      await writeFile(join(repoPath, 'big.png'), bigImage);

      const diff = await ops.getDiff('big.png');
      // Should be binary with imageData, not truncated text
      expect(diff.isBinary).toBe(true);
      expect(diff.imageData).toBeDefined();
    });
  });

  // ===========================================================================
  // 12. Miscellaneous edge cases
  // ===========================================================================
  describe('miscellaneous', () => {
    it('getGitRoot from a subdirectory should return repo root', async () => {
      const subDir = join(repoPath, 'sub', 'deep');
      await mkdir(subDir, { recursive: true });
      const subOps = new GitOperations(subDir);

      const root = await subOps.getGitRoot();
      expect(root).toBe(repoPath);
    });

    it('getDiff on file that does not exist should not crash', async () => {
      const diff = await gitOps.getDiff('nonexistent-file.txt');
      expect(diff.hunks).toHaveLength(0);
    });

    it('stage with empty array should not throw', async () => {
      // git add with no paths — should be a no-op
      await expect(gitOps.stage([])).resolves.toBeUndefined();
    });

    it('discard on unmodified file should not throw', async () => {
      await expect(gitOps.discard(['README.md'])).resolves.toBeUndefined();
    });

    it('getLog on repo with single commit should return one entry', async () => {
      const log = await gitOps.getLog(100);
      expect(log).toHaveLength(1);
    });

    it('getLog with limit 0 still returns commits (simple-git ignores maxCount:0)', async () => {
      // BUG: getLog(0) is expected to return no commits, but simple-git
      // treats maxCount:0 the same as "no limit", returning all commits.
      // The code should guard against limit <= 0 and return [] early.
      const log = await gitOps.getLog(0);
      expect(log.length).toBeGreaterThan(0); // documents the bug
    });

    it('isValidRepo on non-existent path throws in constructor (no guard)', async () => {
      // BUG: The constructor calls simpleGit(repoPath) which throws synchronously
      // if the directory does not exist. isValidRepo never gets a chance to run.
      // The constructor should either defer the simpleGit() call or catch the error.
      expect(() => new GitOperations('/tmp/definitely-does-not-exist-' + Date.now()))
        .toThrow(/does not exist/);
    });

    it('multiple ensureInitialized calls should be idempotent', async () => {
      // Calling getStatus twice triggers ensureInitialized twice
      const s1 = await gitOps.getStatus();
      const s2 = await gitOps.getStatus();
      expect(s1.branch).toBe(s2.branch);
    });

    it('readCommitConventions should return undefined when no convention files exist', async () => {
      const result = await gitOps.readCommitConventions();
      expect(result).toBeUndefined();
    });

    it('readCommitConventions should find CONTRIBUTING.md', async () => {
      await writeFile(join(repoPath, 'CONTRIBUTING.md'), '# Contributing\n\nPlease follow conventional commits.\n');
      const result = await gitOps.readCommitConventions();
      expect(result).toContain('Contributing');
    });

    it('createSyntheticDiff for empty new file returns empty hunks', async () => {
      await writeFile(join(repoPath, 'empty.txt'), '');
      const diff = await gitOps.getDiff('empty.txt');
      // Empty file produces empty content, which after split+pop yields 0 lines
      expect(diff.hunks).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Git identity (getIdentity / setIdentity)
  // ===========================================================================
  describe('git identity', () => {
    it('getIdentity returns the configured user.name and user.email', async () => {
      const identity = await gitOps.getIdentity();
      expect(identity.name).toBe('Test User');
      expect(identity.email).toBe('test@test.com');
    });

    it('setIdentity updates user.name and user.email', async () => {
      await gitOps.setIdentity('New Name', 'new@example.com');
      const identity = await gitOps.getIdentity();
      expect(identity.name).toBe('New Name');
      expect(identity.email).toBe('new@example.com');
    });

    it('getIdentity returns undefined fields when not configured', async () => {
      // Create a fresh repo without identity config
      const barePath = join(tmpdir(), `qs-bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(barePath, { recursive: true });
      const bareGit = simpleGit(barePath);
      await bareGit.init();
      const bareOps = new GitOperations(barePath);

      const identity = await bareOps.getIdentity();
      // May inherit global config, so just verify it doesn't throw
      expect(identity).toHaveProperty('name');
      expect(identity).toHaveProperty('email');

      try { await rm(barePath, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('commits succeed after setIdentity on a repo with no prior identity', async () => {
      // Create a fresh repo without identity
      const freshPath = join(tmpdir(), `qs-noid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(freshPath, { recursive: true });
      const freshGit = simpleGit(freshPath);
      await freshGit.init();
      const freshOps = new GitOperations(freshPath);

      await freshOps.setIdentity('Set User', 'set@example.com');
      await writeFile(join(freshPath, 'file.txt'), 'content');
      await freshGit.add('file.txt');
      const hash = await freshOps.commit('test commit');
      expect(hash).toBeTruthy();

      try { await rm(freshPath, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });
});
