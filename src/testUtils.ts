import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { Project, SourceFile } from 'ts-morph';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const tsxPath = join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliSource = join(repoRoot, 'src', 'tslor.ts');

export function runCLI(
  args: string[],
  cwd: string,
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(tsxPath, [cliSource, ...args], {
    cwd,
    timeout: 10000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: result.error.message,
    };
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function initGitRepo(repoDir: string): void {
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', {
    cwd: repoDir,
    stdio: 'pipe',
  });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git add -A', { cwd: repoDir, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'pipe' });
}

export function createTestSourceFile(sourceCode: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('test.ts', sourceCode);
}

export function createTempDir(setup?: (dir: string) => void): {
  dir: string;
  cleanup: () => void;
} {
  const dir = join(tmpdir(), `tslor-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  setup?.(dir);
  function cleanup() {
    rmSync(dir, { force: true, recursive: true });
  }
  return { dir, cleanup };
}
