import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { ObjStore } from './objstore';
import { Storage } from './storage';
import { RealFileSystem } from './filesystem';
import { assert, test, describe, vi, beforeAll, afterAll } from 'vitest';

/*
  Module-level storage holder. The vi.mock factory captures this reference
  so openStorage() returns whatever is assigned at call time.
*/
let _testStorage: Storage | null = null;

vi.mock('./storage', async () => {
  const actual = await vi.importActual<typeof import('./storage')>('./storage');
  return {
    ...actual,
    Storage: actual.Storage,
    openStorage: vi.fn().mockImplementation(() => {
      if (!_testStorage) {
        throw new Error('testStorage not initialized');
      }
      return _testStorage;
    }),
  };
});

vi.mock('./indexing', async () => {
  const actual = await vi.importActual<typeof import('./indexing')>('./indexing');
  return {
    ...actual,
    updateStorage: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('./project', async () => {
  const actual = await vi.importActual<typeof import('./project')>('./project');
  return {
    ...actual,
    findGitRepoRoot: vi.fn().mockReturnValue('/home/sandbox/repos/tslor'),
  };
});

import { runTsort } from './runTsort';

let testDir: string;
let consoleOutput: string[];

beforeAll(async () => {
  _testStorage = new Storage(
    new ObjStore({ traceId: null }),
    '/dev/null',
    { traceId: null },
    false
  );
  consoleOutput = [];
  vi.spyOn(console, 'log').mockImplementation((msg: string) => {
    consoleOutput.push(msg);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});

  testDir = join(__dirname, '..', '.tslor-test-tsort-tmp');
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
  await writeFile(join(testDir, 'a.ts'), 'import { b } from "./b";\nexport const a = 1;\n');
  await writeFile(join(testDir, 'b.ts'), 'import { c } from "./c";\nexport const b = 2;\n');
  await writeFile(join(testDir, 'c.ts'), 'export const c = 3;\n');
  await writeFile(join(testDir, 'b.js'), 'not typescript\n');

  const aPath = join(testDir, 'a.ts');
  const bPath = join(testDir, 'b.ts');
  const cPath = join(testDir, 'c.ts');
  _testStorage.putImport(aPath, '/tsconfig.json', 0, 'b', { path: bPath, tsconfig: '/tsconfig.json' });
  _testStorage.putImport(bPath, '/tsconfig.json', 0, 'c', { path: cPath, tsconfig: '/tsconfig.json' });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(testDir, { recursive: true, force: true });
});

describe('tsort directory expansion', () => {
  test('directory input expands to TypeScript files and sorts them', async () => {
    await runTsort([testDir], {}, { traceId: null }, new RealFileSystem());

    assert.equal(consoleOutput.length, 3, 'Should output 3 modules');
    assert.equal(consoleOutput[0], join(testDir, 'a.ts'), 'a.ts (imports b) should come first');
    assert.equal(consoleOutput[1], join(testDir, 'b.ts'), 'b.ts (imports c) should come second');
    assert.equal(consoleOutput[2], join(testDir, 'c.ts'), 'c.ts (no imports) should come last');
  });

  test('file input produces identical output as before', async () => {
    const aPath = join(testDir, 'a.ts');
    const bPath = join(testDir, 'b.ts');
    const cPath = join(testDir, 'c.ts');

    consoleOutput = [];
    await runTsort([aPath, bPath, cPath], {}, { traceId: null }, new RealFileSystem());

    assert.equal(consoleOutput.length, 3);
    assert.equal(consoleOutput[0], aPath);
    assert.equal(consoleOutput[1], bPath);
    assert.equal(consoleOutput[2], cPath);
  });
});
