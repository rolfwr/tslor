import { ObjStore } from './objstore';
import { Storage } from './storage';
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
