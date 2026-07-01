import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, test } from 'vitest';
import { runCLI, createTempDir } from './testUtils';

test('tscat writes to stderr and exits with code 1 for missing file', () => {
  const { dir, cleanup } = createTempDir();
  try {
    const { exitCode, stderr, stdout } = runCLI(
      ['tscat', '/nonexistent/file.ts'],
      dir,
    );

    assert.equal(exitCode, 1);
    assert.include(stderr, 'ENOENT');
    assert.equal(stdout, '');
  } finally {
    cleanup();
  }
});

test('inspect writes to stderr and exits with code 1 for missing git repo', () => {
  const { dir, cleanup } = createTempDir();
  try {
    const { exitCode, stderr, stdout } = runCLI(
      ['inspect', '/nonexistent/file.ts'],
      dir,
    );

    assert.equal(exitCode, 1);
    assert.include(stderr, 'Git repo root not found');
    assert.equal(stdout, '');
  } finally {
    cleanup();
  }
});

test('inspect rejects non-TypeScript files with exit code 1', () => {
  const { dir, cleanup } = createTempDir((d) => {
    mkdirSync(join(d, '.git'), { recursive: true });
    writeFileSync(join(d, 'tsconfig.json'), '{}\n');
    writeFileSync(join(d, 'README.md'), '# Hello\n');
    writeFileSync(join(d, 'data.json'), '{}\n');
    writeFileSync(join(d, 'notes.txt'), 'plain text\n');
  });
  try {
    for (const filename of ['README.md', 'data.json', 'notes.txt']) {
      const { exitCode, stderr, stdout } = runCLI(['inspect', filename], dir);

      assert.equal(exitCode, 1);
      assert.include(stderr, 'not a supported file type');
      assert.equal(stdout, '');
    }
  } finally {
    cleanup();
  }
});

test('inspect accepts .ts and .tsx files', () => {
  const { dir, cleanup } = createTempDir((d) => {
    mkdirSync(join(d, '.git'), { recursive: true });
    writeFileSync(join(d, 'tsconfig.json'), '{}\n');
    writeFileSync(join(d, 'mod.ts'), 'export const x = 1;\n');
    writeFileSync(join(d, 'comp.tsx'), 'export const y = 2;\n');
  });
  try {
    for (const filename of ['mod.ts', 'comp.tsx']) {
      const { exitCode, stdout } = runCLI(['inspect', filename], dir);

      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.path, join(dir, filename));
    }
  } finally {
    cleanup();
  }
});

test('inspect writes to stderr and exits with code 1 for missing tsconfig', () => {
  const { dir, cleanup } = createTempDir((d) => {
    mkdirSync(join(d, '.git'), { recursive: true });
    writeFileSync(join(d, 'src.ts'), 'export const x = 1;\n');
  });
  try {
    const { exitCode, stderr, stdout } = runCLI(['inspect', 'src.ts'], dir);

    assert.equal(exitCode, 1);
    assert.include(stderr, 'No tsconfig found');
    assert.equal(stdout, '');
  } finally {
    cleanup();
  }
});
