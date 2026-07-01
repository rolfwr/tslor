/**
 * Fix `needs` to trace Node.js built-in dependencies.
 *
 * The `needs.nodejs` flag must be set to `true` when a module imports from
 * a Node.js built-in module (e.g., `fs`, `path`, `os`), not just when it
 * uses Node.js global identifiers (e.g., `process`, `Buffer`).
 */

import { Project } from 'ts-morph';
import { assert, describe, test } from 'vitest';
import { InMemoryFileSystem } from './filesystem';
import { inspectModule, parseModule } from './indexing';
import { assertDefined } from './invariant';

describe('parseModule detects Node.js built-in imports', () => {
  test('import from fs sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { readFileSync } from 'fs';
console.log(readFileSync('./foo.txt'));
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('import from path sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { join } from 'path';
const p = join('a', 'b');
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('import from node:fs sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { readFileSync } from 'node:fs';
console.log(readFileSync('./foo.txt'));
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('import from os sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { platform } from 'os';
const p = platform();
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('import from child_process sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { spawn } from 'child_process';
spawn('node');
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('namespace import from fs sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import * as fs from 'fs';
fs.readFileSync('./foo.txt');
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('side-effect import from fs sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import 'fs';
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('import from npm package does not set usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { v4 } from 'uuid';
const id = v4();
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, false);
  });

  test('import from relative path does not set usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { foo } from './foo';
foo();
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, false);
  });

  test('import from absolute path does not set usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { foo } from '/some/absolute/foo';
foo();
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, false);
  });

  test('import from scoped package does not set usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { foo } from '@scope/pkg';
foo();
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, false);
  });

  test('node.js global usage still sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
const p = process.cwd();
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('mixed: npm import + node.js built-in import sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
import { v4 } from 'uuid';
import { readFileSync } from 'fs';
const id = v4();
const content = readFileSync('./foo.txt');
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('re-export from fs sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
export { readFileSync } from 'fs';
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('re-export from node:path sets usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
export { join } from 'node:path';
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, true);
  });

  test('re-export from npm package does not set usesNodejsGlobals', () => {
    const sourceFile = createTestSourceFile(`
export { v4 } from 'uuid';
`);
    const info = parseModule(sourceFile);
    assert.strictEqual(info.usesNodejsGlobals, false);
  });
});

describe('inspectModule sets needs.nodejs for built-in imports', () => {
  test('file importing fs has needs.nodejs = true', async () => {
    await assertNeedsNodejs(
      "import { readFileSync } from 'fs';\nexport const content = readFileSync('./foo.txt');\n",
      true,
    );
  });

  test('file importing path has needs.nodejs = true', async () => {
    await assertNeedsNodejs(
      "import { join } from 'path';\nexport const p = join('a', 'b');\n",
      true,
    );
  });

  test('file importing node:fs has needs.nodejs = true', async () => {
    await assertNeedsNodejs(
      "import { readFileSync } from 'node:fs';\nexport const content = readFileSync('./foo.txt');\n",
      true,
    );
  });

  test('file importing only npm packages has needs.nodejs = false', async () => {
    await assertNeedsNodejs(
      "import { v4 } from 'uuid';\nexport const id = v4();\n",
      false,
    );
  });

  test('file with no imports has needs.nodejs = false', async () => {
    await assertNeedsNodejs('export const x = 1;\n', false);
  });
});

async function assertNeedsNodejs(
  sourceCode: string,
  expected: boolean,
): Promise<void> {
  const files = new Map<string, string>([
    ['/repo/tsconfig.json', JSON.stringify({ compilerOptions: {} })],
    ['/repo/src/file.ts', sourceCode],
  ]);
  const fileSystem = new InMemoryFileSystem(files);

  const moduleInfo = await inspectModule(
    '/repo',
    '/repo/src/file.ts',
    fileSystem,
  );
  assertDefined(moduleInfo, 'Module info should be returned');
  assert.strictEqual(moduleInfo.needs.nodejs, expected);
}

function createTestSourceFile(sourceCode: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('test.ts', sourceCode);
}
