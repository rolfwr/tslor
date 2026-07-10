import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ObjStore } from './objstore';
import { Storage, openStorage } from './storage';
import { normalizePath } from './pathUtils';

import { assert, test } from 'vitest';

test('storage timestamp', () => {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, {
    jsonlPath: '/dev/null',
    verbose: true,
    inMemory: true,
  });
  storage.addFileTimestamp('hello', 1000);
  storage.addFileTimestamp('world', 2000);

  const helloTs = storage.getFileTimestamp('hello');
  assert.equal(helloTs, 1000);
  const worldTs = storage.getFileTimestamp('world');
  assert.equal(worldTs, 2000);
});

test('storage import', () => {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, {
    jsonlPath: '/dev/null',
    verbose: true,
    inMemory: true,
  });
  storage.putImport('fileA', '/tsconfig.json', 0, 'nameB', {
    path: 'fileC',
    tsconfig: '/tsconfig.json',
  });
  storage.putImport('fileA', '/tsconfig.json', 1, 'nameD', {
    path: 'fileE',
    tsconfig: '/tsconfig.json',
  });
  storage.putImport('fileA', '/tsconfig.json', 2, 'nameC', { spec: 'specD' });
  storage.putImport('fileB', '/tsconfig.json', 3, 'nameD', {
    path: 'fileE',
    tsconfig: '/tsconfig.json',
  });
  storage.putImport('fileC', '/tsconfig.json', 4, 'nameD', {
    path: 'fileE',
    tsconfig: '/tsconfig.json',
  });

  const importersB = storage.getImportersOfExport('fileC', 'nameB');
  assert.deepEqual(importersB, [normalizePath('fileA')]);

  const importersD = storage.getImportersOfExport('fileE', 'nameD');
  assert.includeMembers(importersD, [
    normalizePath('fileA'),
    normalizePath('fileB'),
    normalizePath('fileC'),
  ]);
  assert.lengthOf(importersD, 3);

  storage.deleteImporterPath('fileA');
  const importersB2 = storage.getImportersOfExport('fileC', 'nameB');
  assert.deepEqual(importersB2, []);
  const importersD2 = storage.getImportersOfExport('fileE', 'nameD');
  assert.deepEqual(importersD2, [
    normalizePath('fileB'),
    normalizePath('fileC'),
  ]);

  storage.deleteImporterPath('fileC');
  const importersD3 = storage.getImportersOfExport('fileE', 'nameD');
  assert.deepEqual(importersD3, [normalizePath('fileB')]);
});

test('a freshly opened store persists across reopen without wiping the index', () => {
  /*
    Regression guard (this bug shipped three times). A freshly opened store puts
    _schemaVersion but must also be marked dirty; otherwise save() no-ops, the
    version is never written, and the next open sees no version, treats the
    schema as mismatched, and deletes the index — on every open. The bug only
    surfaces on the no-data-write path: any data put dirties the store and masks
    it, so this test writes nothing before the first save. It exercises the real
    openStorage -> save -> reopen path rather than crafting the state directly.
  */
  const tmpDir = mkdtempSync(join(tmpdir(), 'tslor-storage-'));
  const debug = { traceId: null };
  const options = { verbose: false, basePath: tmpDir, inMemory: false };
  try {
    const first = openStorage(debug, options);
    first.save();

    // A fresh store must persist on save even when nothing else was written.
    assert.isAbove(
      readdirSync(tmpDir).length,
      0,
      'fresh store did not persist on save',
    );

    // Reopening a store whose version matches must not wipe the persisted file.
    openStorage(debug, options);
    assert.isAbove(
      readdirSync(tmpDir).length,
      0,
      'reopening a matching-version store wiped the index',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
