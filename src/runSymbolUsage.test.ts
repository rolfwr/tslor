import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, test } from 'vitest';
import { resolveProjectPath } from './runSymbolUsage';

/**
 * Create a temporary git repo on disk. Returns the absolute path to the repo
 * root and a cleanup function. A `.git` marker directory is created so
 * `findGitRepoRoot` works.
 */
function createGitRepo(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `tslor-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });

  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

describe('resolveProjectPath', () => {
  test('resolves relative project path against repo root of cwd', () => {
    const { dir: cwdRepo, cleanup } = createGitRepo();

    try {
      const result = resolveProjectPath('common', cwdRepo);

      assert.equal(
        result.absoluteProjectPath,
        join(cwdRepo, 'common'),
        'Relative path should resolve against repo root',
      );
      assert.equal(
        result.repoRoot,
        cwdRepo,
        'Repo root should be derived from cwd',
      );
    } finally {
      cleanup();
    }
  });

  test('resolves absolute project path against its own repo root', () => {
    const { dir: repoRoot, cleanup } = createGitRepo();

    try {
      const absoluteProjectPath = join(repoRoot, 'common');
      const result = resolveProjectPath(absoluteProjectPath, '/some/other/dir');

      assert.equal(
        result.absoluteProjectPath,
        absoluteProjectPath,
        'Absolute path should pass through unchanged',
      );
      assert.equal(
        result.repoRoot,
        repoRoot,
        'Repo root should be derived from the absolute path, not cwd',
      );
    } finally {
      cleanup();
    }
  });

  test('resolves relative project path against --repo root when provided', () => {
    const { dir: cwdRepo, cleanup: cleanupCwd } = createGitRepo();
    const { dir: targetRepo, cleanup: cleanupTarget } = createGitRepo();

    try {
      const result = resolveProjectPath('common', cwdRepo, targetRepo);

      assert.equal(
        result.absoluteProjectPath,
        join(targetRepo, 'common'),
        'Relative path should resolve against --repo root, not cwd',
      );
      assert.equal(
        result.repoRoot,
        targetRepo,
        'Repo root should be the --repo value, not derived from cwd',
      );
    } finally {
      cleanupCwd();
      cleanupTarget();
    }
  });

  test('--repo has no effect when project path is absolute', () => {
    const { dir: cwdRepo, cleanup: cleanupCwd } = createGitRepo();
    const { dir: targetRepo, cleanup: cleanupTarget } = createGitRepo();
    const { dir: projectRepo, cleanup: cleanupProject } = createGitRepo();

    try {
      const absoluteProjectPath = join(projectRepo, 'common');
      const result = resolveProjectPath(
        absoluteProjectPath,
        cwdRepo,
        targetRepo,
      );

      assert.equal(
        result.absoluteProjectPath,
        absoluteProjectPath,
        'Absolute path should pass through unchanged regardless of --repo',
      );
      assert.equal(
        result.repoRoot,
        projectRepo,
        'Repo root should be derived from the absolute path, not --repo',
      );
    } finally {
      cleanupCwd();
      cleanupTarget();
      cleanupProject();
    }
  });
});
