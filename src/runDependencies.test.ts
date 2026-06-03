import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjStore } from './objstore';
import { Storage } from './storage';
import { InMemoryFileSystem } from './filesystem';
import { assert, test, describe, beforeEach } from 'vitest';
import { runDependencies } from './runDependencies';

const __dirname = dirname(fileURLToPath(import.meta.url));

let testDir: string;
let storage: Storage;

beforeEach(() => {
  testDir = join(__dirname, '.tslor-test-deps-tmp');

  const objStore = new ObjStore({ traceId: null });
  storage = new Storage(objStore, '/dev/null', { traceId: null }, false);

  const aPath = join(testDir, 'a.ts');
  const bPath = join(testDir, 'b.ts');
  const cPath = join(testDir, 'c.ts');
  // a imports b, b imports c
  storage.putImport(aPath, '/tsconfig.json', 0, 'b', { path: bPath, tsconfig: '/tsconfig.json' });
  storage.putImport(bPath, '/tsconfig.json', 0, 'c', { path: cPath, tsconfig: '/tsconfig.json' });
});

describe('runDependencies file input (backward compat)', () => {
  test('file-only input produces identical output as before', async () => {
    const files = new Map<string, string>([
      [join(testDir, 'a.ts'), 'import { b } from "./b";\nexport const a = 1;\n'],
      [join(testDir, 'b.ts'), 'import { c } from "./c";\nexport const b = 2;\n'],
      [join(testDir, 'c.ts'), 'export const c = 3;\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const aPath = join(testDir, 'a.ts');
    const logs: string[] = [];

    await runDependencies(
      [aPath],
      {
        repoRoot: testDir,
        storage,
        output: { log: (msg) => logs.push(msg) },
      },
      { traceId: null },
      fileSystem
    );

    /*
      a.ts imports b.ts, b.ts imports c.ts. The forward-import walk
      starting from a.ts reaches all three modules. The shared `seen` set
      ensures each module is printed exactly once.
    */
    assert.lengthOf(logs, 3);
    assert.isTrue(logs.includes(aPath), 'a.ts should be in output');
    assert.isTrue(logs.includes(join(testDir, 'b.ts')), 'b.ts should be in output');
    assert.isTrue(logs.includes(join(testDir, 'c.ts')), 'c.ts should be in output');
  });
});

describe('runDependencies directory expansion', () => {
  test('directory input expands to TypeScript files and lists all dependencies', async () => {
    const files = new Map<string, string>([
      [join(testDir, 'a.ts'), 'import { b } from "./b";\nexport const a = 1;\n'],
      [join(testDir, 'b.ts'), 'import { c } from "./c";\nexport const b = 2;\n'],
      [join(testDir, 'c.ts'), 'export const c = 3;\n'],
      [join(testDir, 'd.js'), 'not typescript\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const logs: string[] = [];

    await runDependencies(
      [testDir],
      {
        repoRoot: testDir,
        storage,
        output: { log: (msg) => logs.push(msg) },
      },
      { traceId: null },
      fileSystem
    );

    /*
      Directory expansion finds a.ts, b.ts, c.ts (not d.js).
      The forward-import walk covers all three TypeScript modules.
    */
    const aPath = join(testDir, 'a.ts');
    const bPath = join(testDir, 'b.ts');
    const cPath = join(testDir, 'c.ts');

    // All three TypeScript files should appear in output
    assert.lengthOf(logs, 3);
    assert.isTrue(logs.includes(aPath), 'a.ts should be in output');
    assert.isTrue(logs.includes(bPath), 'b.ts should be in output');
    assert.isTrue(logs.includes(cPath), 'c.ts should be in output');
    // d.js should NOT appear
    assert.isFalse(
      logs.some(l => l.endsWith('d.js')),
      'd.js should not be in output'
    );
  });
});

describe('runDependencies empty input', () => {
  test('empty paths array throws error', async () => {
    const files = new Map<string, string>();
    const fileSystem = new InMemoryFileSystem(files);

    try {
      await runDependencies(
        [],
        { repoRoot: testDir, storage },
        { traceId: null },
        fileSystem
      );
      throw new Error('Expected runDependencies to throw');
    } catch (err) {
      if (!(err instanceof Error)) {
        throw err;
      }
      assert.include(err.message, 'No module paths provided');
    }
  });

  test('directory with no TypeScript files throws error', async () => {
    const emptyDir = join(testDir, 'empty');
    const files = new Map<string, string>([
      [join(emptyDir, 'readme.md'), 'no ts files here\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    try {
      await runDependencies(
        [emptyDir],
        { repoRoot: testDir, storage },
        { traceId: null },
        fileSystem
      );
      throw new Error('Expected runDependencies to throw');
    } catch (err) {
      if (!(err instanceof Error)) {
        throw err;
      }
      assert.include(err.message, 'no TypeScript modules');
    }
  });
});

describe('runDependencies mixed input', () => {
  test('mixed file and directory input works', async () => {
    const subDir = join(testDir, 'sub');
    const files = new Map<string, string>([
      [join(testDir, 'a.ts'), 'import { b } from "./sub/b";\nexport const a = 1;\n'],
      [join(subDir, 'b.ts'), 'export const b = 2;\n'],
      [join(subDir, 'c.ts'), 'export const c = 3;\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const aPath = join(testDir, 'a.ts');
    const bPath = join(subDir, 'b.ts');
    const cPath = join(subDir, 'c.ts');

    // Set up storage: a imports sub/b
    storage.putImport(aPath, '/tsconfig.json', 0, 'b', { path: bPath, tsconfig: '/tsconfig.json' });

    const logs: string[] = [];

    // Pass explicit file + directory
    await runDependencies(
      [aPath, subDir],
      {
        repoRoot: testDir,
        storage,
        output: { log: (msg) => logs.push(msg) },
      },
      { traceId: null },
      fileSystem
    );

    // All resolved files should appear in output
    assert.isTrue(logs.includes(aPath), 'a.ts should be in output');
    assert.isTrue(logs.includes(bPath), 'sub/b.ts should be in output');
    assert.isTrue(logs.includes(cPath), 'sub/c.ts should be in output');
  });
});
