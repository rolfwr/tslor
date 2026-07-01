import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assert, test } from 'vitest';
import { runCLI, initGitRepo, createTempDir } from './testUtils';

test('mv resolves relative destination path against repo root, not CWD', () => {
  const { dir: testDir, cleanup } = createTempDir((d) => {
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
  });

  initGitRepo(testDir);

  try {
    const result = runCLI(['mv', '../src/a.ts', 'dest'], join(testDir, 'sub'));
    assert.equal(result.exitCode, 0, `CLI failed: ${result.stderr}`);

    const expectedPath = join(testDir, 'dest', 'a.ts');
    const wrongPath = join(testDir, 'sub', 'dest', 'a.ts');

    assert.isTrue(
      existsSync(expectedPath),
      `File should be at ${expectedPath} (resolved against repo root), not ${wrongPath} (resolved against CWD)`,
    );

    assert.isFalse(
      existsSync(wrongPath),
      `File should NOT be at ${wrongPath} (CWD-relative resolution is wrong)`,
    );
  } finally {
    cleanup();
  }
});
