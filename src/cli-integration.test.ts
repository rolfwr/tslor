/*
  CLI integration tests

  Tests that spawn the tslor CLI subprocess. Minimized to essential
  integration scenarios.
*/

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assert, describe, test } from 'vitest';
import { runCLI, initGitRepo, createTempDir } from './testUtils';

describe('CLI error handling', () => {
  test.concurrent('tscat exits with code 1 for missing file', async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const { exitCode, stderr } = await runCLI(
        ['tscat', '/nonexistent/file.ts'],
        dir,
      );
      assert.equal(exitCode, 1);
      assert.include(stderr, 'ENOENT');
      assert.include(stderr, '/nonexistent/file.ts');
      // CLI error output must not leak raw stack traces to the user.
      assert.notInclude(stderr, 'at readFileSync');
      assert.notInclude(stderr, 'at runTscat');
    } finally {
      cleanup();
    }
  });

  test.concurrent('inspect exits with code 1 for missing git repo', async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const { exitCode, stderr } = await runCLI(
        ['inspect', '/nonexistent/file.ts'],
        dir,
      );
      assert.equal(exitCode, 1);
      assert.include(stderr, 'Git repo root not found');
    } finally {
      cleanup();
    }
  });

  test.concurrent('inspect exits with code 1 for missing tsconfig', async () => {
    const { dir, cleanup } = createTempDir({
      setup: (d) => {
        mkdirSync(join(d, '.git'), { recursive: true });
        writeFileSync(join(d, 'src.ts'), 'export const x = 1;\n');
      },
    });
    try {
      const { exitCode, stderr } = await runCLI(['inspect', 'src.ts'], dir);
      assert.equal(exitCode, 1);
      assert.include(stderr, 'No tsconfig found');
    } finally {
      cleanup();
    }
  });

  test.concurrent.each([
    'md',
    'json',
    'txt',
  ])('inspect rejects .%s files', async (ext) => {
    const { dir, cleanup } = createTempDir({
      setup: (d) => {
        writeFileSync(join(d, `file.${ext}`), 'content\n');
      },
    });
    try {
      const { exitCode, stderr } = await runCLI(
        ['inspect', `file.${ext}`],
        dir,
      );
      assert.equal(exitCode, 1);
      assert.include(stderr, 'not a supported file type');
    } finally {
      cleanup();
    }
  });

  test.concurrent.each([
    'ts',
    'tsx',
  ])('inspect accepts .%s files', async (ext) => {
    const { dir, cleanup } = createTempDir({
      setup: (d) => {
        mkdirSync(join(d, '.git'), { recursive: true });
        writeFileSync(join(d, 'tsconfig.json'), '{}\n');
        writeFileSync(join(d, `mod.${ext}`), 'export const x = 1;\n');
      },
    });
    try {
      const { exitCode, stdout } = await runCLI(['inspect', `mod.${ext}`], dir);
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.path, join(dir, `mod.${ext}`));
    } finally {
      cleanup();
    }
  });
});

async function runMvTest(
  files: Record<string, string>,
  [source, dest]: [string, string],
): Promise<string> {
  const { dir, cleanup } = createTempDir({
    files,
    setup: (d) => {
      mkdirSync(join(d, dirname(dest)), { recursive: true });

      writeFileSync(
        join(d, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ES2022',
            moduleResolution: 'bundler',
            paths: {
              '@test/*': ['./src/*'],
            },
          },
          include: ['src/**/*.ts'],
        }),
      );
    },
  });

  try {
    initGitRepo(dir);
    const result = await runCLI(['--fresh', 'mv', source, dest], dir);
    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);
    return readFileSync(join(dir, dest), 'utf-8');
  } finally {
    cleanup();
  }
}

describe('mv command', () => {
  test.concurrent('rejects identical source and destination', async () => {
    const { dir, cleanup } = createTempDir({
      files: {
        'src/a.ts': 'export const a = 1;\n',
        'tsconfig.json': '{}\n',
      },
    });
    try {
      initGitRepo(dir);
      const { exitCode, stderr } = await runCLI(
        ['--fresh', 'mv', 'src/a.ts', 'src/a.ts'],
        dir,
      );
      assert.equal(exitCode, 1);
      assert.include(stderr, 'Source and destination are the same file');
    } finally {
      cleanup();
    }
  });

  test.concurrent('updates relative imports when moving deeper', async () => {
    const content = await runMvTest(
      {
        'src/util/errnoException.ts':
          'export function isFileOrDirectoryMissingError() { return true; }\n',
        'src/os/file.ts':
          "import { isFileOrDirectoryMissingError } from '../util/errnoException';\nexport const a = 1;\n",
      },
      ['src/os/file.ts', 'src/os/subdir/file.ts'],
    );
    assert.include(content, "'../../util/errnoException'");
  });

  test.concurrent('updates relative imports when moving shallower', async () => {
    const content = await runMvTest(
      {
        'src/util/errnoException.ts':
          'export function isFileOrDirectoryMissingError() { return true; }\n',
        'src/os/subdir/file.ts':
          "import { isFileOrDirectoryMissingError } from '../../util/errnoException';\nexport const a = 1;\n",
      },
      ['src/os/subdir/file.ts', 'src/os/file.ts'],
    );
    assert.include(content, "'../util/errnoException'");
  });

  test.concurrent('preserves alias/external imports and updates relative ones on sideways move', async () => {
    const content = await runMvTest(
      {
        'src/shared/helper.ts': 'export function helper() { return true; }\n',
        'src/a/file.ts':
          "import { helper } from '../shared/helper';\nimport { alias } from '@test/shared/helper';\nimport { existsSync } from 'fs';\nexport const a = 1;\n",
      },
      ['src/a/file.ts', 'src/b/file.ts'],
    );
    assert.include(content, "'../shared/helper'");
    assert.include(content, "'@test/shared/helper'");
    assert.include(content, "'fs'");
  });

  test.concurrent('resolves relative destination path against repo root not CWD', async () => {
    const { dir, cleanup } = createTempDir({
      setup: (d) => {
        mkdirSync(join(d, 'src'), { recursive: true });
        mkdirSync(join(d, 'dest'), { recursive: true });
        mkdirSync(join(d, 'sub'), { recursive: true });

        writeFileSync(
          join(d, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'ES2022',
              moduleResolution: 'bundler',
            },
          }),
        );

        writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
      },
    });

    try {
      initGitRepo(dir);
      const result = await runCLI(
        ['--fresh', 'mv', '../src/a.ts', 'dest'],
        join(dir, 'sub'),
      );
      assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

      const expectedPath = join(dir, 'dest', 'a.ts');
      const wrongPath = join(dir, 'sub', 'dest', 'a.ts');

      assert.isTrue(existsSync(expectedPath));
      assert.isFalse(existsSync(wrongPath));
    } finally {
      cleanup();
    }
  });
});
