import { assert, test } from 'vitest';

import { ObjStore } from './objstore';
import { Storage } from './storage';
import { normalizePath } from './pathUtils';

function createStorage(): Storage {
  const objStore = new ObjStore({ traceId: null });
  return new Storage(objStore, {
    jsonlPath: '/dev/null',
    verbose: false,
    inMemory: true,
  });
}

test('putImport normalizes relative and absolute paths to same key', () => {
  const storage = createStorage();
  const relativePath = 'src/foo.ts';
  const absolutePath = normalizePath('src/foo.ts');

  storage.putImport(relativePath, '/tsconfig.json', 0, 'nameB', {
    path: 'src/bar.ts',
    tsconfig: '/tsconfig.json',
  });

  const imports = storage.getImportsFromFile(absolutePath);
  assert.strictEqual(
    imports.length,
    1,
    'Relative and absolute paths must resolve to the same storage key',
  );
});

test('putReExport normalizes relative and absolute paths to same key', () => {
  const storage = createStorage();
  const relativePath = 'src/foo.ts';
  const absolutePath = normalizePath('src/foo.ts');

  storage.putReExport(relativePath, 0, 'nameB', {
    moduleSpec: './bar',
    isTypeOnly: false,
  });

  const reExports = storage.getReExportsFromFile(absolutePath);
  assert.strictEqual(
    reExports.length,
    1,
    'Relative and absolute paths must resolve to the same storage key',
  );
});

test('deleteImporterPath works regardless of path format used at insert', () => {
  const storage = createStorage();
  const relativePath = 'src/foo.ts';
  const absolutePath = normalizePath('src/foo.ts');

  storage.putImport(relativePath, '/tsconfig.json', 0, 'nameB', {
    path: 'src/bar.ts',
    tsconfig: '/tsconfig.json',
  });

  assert.strictEqual(storage.getImportsFromFile(absolutePath).length, 1);

  storage.deleteImporterPath(absolutePath);
  assert.strictEqual(
    storage.getImportsFromFile(absolutePath).length,
    0,
    'deleteImporterPath must work with normalized path',
  );
});

test('addFileTimestamp normalizes paths', () => {
  const storage = createStorage();
  const relativePath = 'src/foo.ts';
  const absolutePath = normalizePath('src/foo.ts');

  storage.addFileTimestamp(relativePath, 1000);

  const ts = storage.getFileTimestamp(absolutePath);
  assert.strictEqual(
    ts,
    1000,
    'Relative and absolute paths must resolve to the same timestamp key',
  );
});

test('putModuleNeeds normalizes paths', () => {
  const storage = createStorage();
  const relativePath = 'src/foo.ts';
  const absolutePath = normalizePath('src/foo.ts');

  storage.putModuleNeeds(relativePath, { ambientNames: ['process'] });

  const needs = storage.getModuleNeeds(absolutePath);
  assert.deepEqual(
    needs,
    { ambientNames: ['process'] },
    'Relative and absolute paths must resolve to the same needs key',
  );
});
