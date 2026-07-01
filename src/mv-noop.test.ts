import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, test } from 'vitest';
import { runCLI, initGitRepo, createTempDir } from './testUtils';

test('mv rejects identical source and destination with clear error', () => {
  const { dir: testDir, cleanup } = createTempDir((d) => {
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  });

  initGitRepo(testDir);

  try {
    const { exitCode, stderr } = runCLI(
      ['mv', 'src/a.ts', 'src/a.ts'],
      testDir,
    );

    assert.equal(
      exitCode,
      1,
      'Expected exit code 1 when source and destination are the same',
    );

    assert.include(
      stderr,
      'Source and destination are the same file',
      'Error message should clearly state that source and destination are the same',
    );
  } finally {
    cleanup();
  }
});
