import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assert, test } from 'vitest';
import { openStorage } from './storage';

test('--fresh deletes existing database before opening storage', () => {
  const testDir = join(tmpdir(), 'tslor-fresh-test-' + randomUUID());
  try {
    mkdirSync(testDir, { recursive: true });
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
    rmSync(testDir, { force: true, recursive: true });
  }
});

test('--fresh is a no-op when no database exists', () => {
  const testDir = join(tmpdir(), 'tslor-fresh-test-' + randomUUID());
  try {
    mkdirSync(testDir, { recursive: true });

    openStorage(
      { traceId: null },
      { verbose: false, fresh: true, basePath: testDir, inMemory: false },
    );
  } finally {
    rmSync(testDir, { force: true, recursive: true });
  }
});
