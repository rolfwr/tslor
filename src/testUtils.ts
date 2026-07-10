import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { Project, SourceFile } from 'ts-morph';
import { parseModule, StaticModuleInfo } from './indexing';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const tsxPath = join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliSource = join(repoRoot, 'src', 'tslor.ts');

export function runCLI(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    let timedOut = false;

    const child = spawn(tsxPath, [cliSource, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        timedOut = true;
        child.kill('SIGKILL');
      }
    }, 10000);

    const finish = (exitCode: number, out: string, err: string) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeoutId);
      resolve({ exitCode, stdout: out, stderr: err });
    };

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish(-1, stdout, stderr + '\nProcess timed out after 10000ms');
      } else {
        finish(code ?? 1, stdout, stderr);
      }
    });

    child.on('error', (err) => {
      finish(-1, stdout, err.message);
    });
  });
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

// RATIONALE: test helper — test file signatures exempted by convention
// ast-grep-ignore: no-optional-param
export function createTempDir(options?: {
  files?: Record<string, string>;
  setup?: (dir: string) => void;
}): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `tslor-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });

  for (const [relativePath, content] of Object.entries(options?.files ?? {})) {
    const fullPath = join(dir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  options?.setup?.(dir);

  function cleanup() {
    rmSync(dir, { force: true, recursive: true });
  }
  return { dir, cleanup };
}

export function parseIsolatedSourceCode(sourceCode: string): StaticModuleInfo {
  return parseModule(createTestSourceFile(sourceCode));
}
