import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjStore } from './objstore';
import { Storage } from './storage';
import { InMemoryFileSystem } from './filesystem';
import { assert, test, describe, beforeEach } from 'vitest';
import { runTsort } from './runTsort';

const __dirname = dirname(fileURLToPath(import.meta.url));

let testDir: string;
let consoleOutput: string[];
let storage: Storage;

beforeEach(() => {
  testDir = join(__dirname, '.tslor-test-tsort-tmp');

  consoleOutput = [];

  const objStore = new ObjStore({ traceId: null });
  storage = new Storage(objStore, '/dev/null', { traceId: null }, false);

  const aPath = join(testDir, 'a.ts');
  const bPath = join(testDir, 'b.ts');
  const cPath = join(testDir, 'c.ts');
  storage.putImport(aPath, '/tsconfig.json', 0, 'b', { path: bPath, tsconfig: '/tsconfig.json' });
  storage.putImport(bPath, '/tsconfig.json', 0, 'c', { path: cPath, tsconfig: '/tsconfig.json' });
});

describe('tsort directory expansion', () => {
  test('directory input expands to TypeScript files and sorts them', async () => {
    const files = new Map<string, string>([
      [join(testDir, 'a.ts'), 'import { b } from "./b";\nexport const a = 1;\n'],
      [join(testDir, 'b.ts'), 'import { c } from "./c";\nexport const b = 2;\n'],
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
      },
      { traceId: null },
      fileSystem
    );

    assert.equal(consoleOutput.length, 3, 'Should output 3 modules');
    assert.equal(consoleOutput[0], join(testDir, 'c.ts'), 'c.ts (no imports) should come first');
    assert.equal(consoleOutput[1], join(testDir, 'b.ts'), 'b.ts (imports c) should come second');
    assert.equal(consoleOutput[2], join(testDir, 'a.ts'), 'a.ts (imports b) should come last');
  });

  test('file input produces identical output as before', async () => {
    const files = new Map<string, string>([
      [join(testDir, 'a.ts'), 'import { b } from "./b";\nexport const a = 1;\n'],
      [join(testDir, 'b.ts'), 'import { c } from "./c";\nexport const b = 2;\n'],
      [join(testDir, 'c.ts'), 'export const c = 3;\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const aPath = join(testDir, 'a.ts');
    const bPath = join(testDir, 'b.ts');
    const cPath = join(testDir, 'c.ts');

    await runTsort(
      [aPath, bPath, cPath],
      {
        repoRoot: testDir,
        output: {
          log: (msg: string) => consoleOutput.push(msg),
        },
        storage,
      },
      { traceId: null },
      fileSystem
    );

    assert.equal(consoleOutput.length, 3);
    assert.equal(consoleOutput[0], cPath);
    assert.equal(consoleOutput[1], bPath);
    assert.equal(consoleOutput[2], aPath);
  });
});
