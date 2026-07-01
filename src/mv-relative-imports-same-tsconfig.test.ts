import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assert, test } from 'vitest';
import { runCLI, initGitRepo, createTempDir } from './testUtils';

function runMvTest(
  files: { path: string; content: string }[],
  mvArgs: [string, string],
): string {
  const { dir: testDir, cleanup } = createTempDir((d) => {
    for (const { path, content } of files) {
      mkdirSync(join(d, dirname(path)), { recursive: true });
      writeFileSync(join(d, path), content);
    }
    mkdirSync(join(d, dirname(mvArgs[1])), { recursive: true });

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
  });

  initGitRepo(testDir);

  try {
    const result = runCLI(['mv', ...mvArgs], testDir);
    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);
    return readFileSync(join(testDir, mvArgs[1]), 'utf-8');
  } finally {
    cleanup();
  }
}

test('mv updates relative imports in moved file when staying within same tsconfig', () => {
  const content = runMvTest(
    [
      {
        path: 'src/util/errnoException.ts',
        content:
          'export function isFileOrDirectoryMissingError() { return true; }\n',
      },
      {
        path: 'src/os/file.ts',
        content:
          "import { isFileOrDirectoryMissingError } from '../util/errnoException';\nexport const a = 1;\n",
      },
    ],
    ['src/os/file.ts', 'src/os/subdir/file.ts'],
  );
  assert.include(
    content,
    "'../../util/errnoException'",
    'Relative import should be updated to ../../util/errnoException after moving deeper',
  );
});

test('mv updates relative imports when moving file to a shallower directory within same tsconfig', () => {
  const content = runMvTest(
    [
      {
        path: 'src/util/errnoException.ts',
        content:
          'export function isFileOrDirectoryMissingError() { return true; }\n',
      },
      {
        path: 'src/os/subdir/file.ts',
        content:
          "import { isFileOrDirectoryMissingError } from '../../util/errnoException';\nexport const a = 1;\n",
      },
    ],
    ['src/os/subdir/file.ts', 'src/os/file.ts'],
  );
  assert.include(
    content,
    "'../util/errnoException'",
    'Relative import should be updated to ../util/errnoException after moving shallower',
  );
});

test('mv updates relative imports when moving file sideways within same tsconfig', () => {
  const content = runMvTest(
    [
      {
        path: 'src/shared/helper.ts',
        content: 'export function helper() { return true; }\n',
      },
      {
        path: 'src/a/file.ts',
        content:
          "import { helper } from '../shared/helper';\nexport const a = 1;\n",
      },
    ],
    ['src/a/file.ts', 'src/b/file.ts'],
  );
  assert.include(
    content,
    "'../shared/helper'",
    'Relative import should remain ../shared/helper for sideways move at same depth',
  );
});

test('mv leaves alias imports untouched when staying within same tsconfig', () => {
  const content = runMvTest(
    [
      {
        path: 'src/util/errnoException.ts',
        content:
          'export function isFileOrDirectoryMissingError() { return true; }\n',
      },
      {
        path: 'src/os/file.ts',
        content:
          "import { isFileOrDirectoryMissingError } from '@test/util/errnoException';\nexport const a = 1;\n",
      },
    ],
    ['src/os/file.ts', 'src/os/subdir/file.ts'],
  );
  assert.include(
    content,
    "'@test/util/errnoException'",
    'Alias import should remain unchanged within same tsconfig',
  );
});

test('mv leaves external imports untouched when staying within same tsconfig', () => {
  const content = runMvTest(
    [
      {
        path: 'src/os/file.ts',
        content:
          "import { existsSync } from 'fs';\nimport { basename } from 'path';\nexport const a = 1;\n",
      },
    ],
    ['src/os/file.ts', 'src/os/subdir/file.ts'],
  );
  assert.include(content, "'fs'", 'External import fs should remain unchanged');
  assert.include(
    content,
    "'path'",
    'External import path should remain unchanged',
  );
});
