import { ObjStore } from './objstore.js';
import { Storage } from './storage.js';

import { assert, test } from 'vitest'


test('storage timestamp', () => {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, '/dev/null', { traceId: null }, true);
  storage.addFileTimestamp('hello', 1000);
  storage.addFileTimestamp('world', 2000);

  const helloTs = storage.getFileTimestamp('hello');
  assert.equal(helloTs, 1000);
  const worldTs = storage.getFileTimestamp('world');
  assert.equal(worldTs, 2000);
});

test('storage import', () => {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, '/dev/null', { traceId: null }, true);
  storage.putImport('fileA', '/tsconfig.json', 0, 'nameB', { path: 'fileC', tsconfig: '/tsconfig.json' });
  storage.putImport('fileA', '/tsconfig.json', 1, 'nameD', { path: 'fileE', tsconfig: '/tsconfig.json' });
  storage.putImport('fileA', '/tsconfig.json', 2, 'nameC', { spec: 'specD' });
  storage.putImport('fileB', '/tsconfig.json', 3, 'nameD', { path: 'fileE', tsconfig: '/tsconfig.json' });
  storage.putImport('fileC', '/tsconfig.json', 4, 'nameD', { path: 'fileE', tsconfig: '/tsconfig.json' });

  const importersB = storage.getImportersOfExport('fileC', 'nameB');
  assert.deepEqual(importersB, ['fileA']);

  const importersD = storage.getImportersOfExport('fileE', 'nameD');
  assert.includeMembers(importersD, ['fileA', 'fileB', 'fileC']);
  assert.lengthOf(importersD, 3);

  storage.deleteImporterPath('fileA');
  const importersB2 = storage.getImportersOfExport('fileC', 'nameB');
  assert.deepEqual(importersB2, []);
  const importersD2 = storage.getImportersOfExport('fileE', 'nameD');
  assert.deepEqual(importersD2, ['fileB', 'fileC']);

  storage.deleteImporterPath('fileC');
  const importersD3 = storage.getImportersOfExport('fileE', 'nameD');
  assert.deepEqual(importersD3, ['fileB']);

});