import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assert, test } from 'vitest';
import { createTempDir } from './testUtils';
import { openStorage } from './storage';

test('--fresh deletes existing database before opening storage', () => {
  const { dir: testDir, cleanup } = createTempDir();
  try {
    const dbPath = join(testDir, '_objstore.jsonl');
    writeFileSync(dbPath, 'STALE_DATABASE_ENTRY');

    openStorage(
      { traceId: null },
      { verbose: false, fresh: true, basePath: testDir, inMemory: false },
    );

    assert.isFalse(
      existsSync(dbPath),
      '--fresh should have deleted the stale database',
    );
  } finally {
    cleanup();
  }
});

test('--fresh is a no-op when no database exists', () => {
  const { dir: testDir, cleanup } = createTempDir();
  try {
    openStorage(
      { traceId: null },
      { verbose: false, fresh: true, basePath: testDir, inMemory: false },
    );
  } finally {
    cleanup();
  }
});
