import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjStore } from './objstore';
import { Storage } from './storage';
import { InMemoryFileSystem } from './filesystem';
import { assert, test, describe } from 'vitest';
import { runTsort } from './runTsort';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createStorage(aPath: string, bPath: string, cPath: string): Storage {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, {
    jsonlPath: '/dev/null',
    verbose: false,
    inMemory: true,
  });

  storage.putImport(aPath, '/tsconfig.json', 0, 'b', {
    path: bPath,
    tsconfig: '/tsconfig.json',
  });
  storage.putImport(bPath, '/tsconfig.json', 0, 'c', {
    path: cPath,
    tsconfig: '/tsconfig.json',
  });
  return storage;
}

describe('tsort directory expansion', () => {
  test('directory input expands to TypeScript files and sorts them', async () => {
    const testDir = join(__dirname, '.tslor-test-tsort-tmp');
    const aPath = join(testDir, 'a.ts');
    const bPath = join(testDir, 'b.ts');
    const cPath = join(testDir, 'c.ts');
    const storage = createStorage(aPath, bPath, cPath);
    const consoleOutput: string[] = [];

    const files = new Map<string, string>([
      [
        join(testDir, 'a.ts'),
        'import { b } from "./b";\nexport const a = 1;\n',
      ],
      [
        join(testDir, 'b.ts'),
        'import { c } from "./c";\nexport const b = 2;\n',
      ],
      [join(testDir, 'c.ts'), 'export const c = 3;\n'],
      [join(testDir, 'b.js'), 'not typescript\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    await runTsort(
      [testDir],
      {
        repoRoot: testDir,
        output: {
          log: (msg: string) => consoleOutput.push(msg),
        },
        storage,
        cwd: testDir,
      },
      { traceId: null },
      fileSystem,
    );

    assert.equal(consoleOutput.length, 3, 'Should output 3 modules');
    assert.equal(
      consoleOutput[0],
      join(testDir, 'c.ts'),
      'c.ts (no imports) should come first',
    );
    assert.equal(
      consoleOutput[1],
      join(testDir, 'b.ts'),
      'b.ts (imports c) should come second',
    );
    assert.equal(
      consoleOutput[2],
      join(testDir, 'a.ts'),
      'a.ts (imports b) should come last',
    );
  });

  test('explicit file paths are sorted in dependency order', async () => {
    const testDir = join(__dirname, '.tslor-test-tsort-tmp');
    const aPath = join(testDir, 'a.ts');
    const bPath = join(testDir, 'b.ts');
    const cPath = join(testDir, 'c.ts');
    const storage = createStorage(aPath, bPath, cPath);
    const consoleOutput: string[] = [];

    const files = new Map<string, string>([
      [aPath, 'import { b } from "./b";\nexport const a = 1;\n'],
      [bPath, 'import { c } from "./c";\nexport const b = 2;\n'],
      [cPath, 'export const c = 3;\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    await runTsort(
      [aPath, bPath, cPath],
      {
        repoRoot: testDir,
        output: {
          log: (msg: string) => consoleOutput.push(msg),
        },
        storage,
        cwd: testDir,
      },
      { traceId: null },
      fileSystem,
    );

    assert.equal(consoleOutput.length, 3, 'Should output 3 modules');
    assert.equal(
      consoleOutput[0],
      cPath,
      'c.ts (no imports) should come first',
    );
    assert.equal(
      consoleOutput[1],
      bPath,
      'b.ts (imports c) should come second',
    );
    assert.equal(consoleOutput[2], aPath, 'a.ts (imports b) should come last');
  });
});
