/**
 * Generalized ambient-name report replaces Node.js-specific needs.
 *
 * Tests that ambient names are detected correctly by parseModule and
 * inspectModule.
 */

import { Project } from 'ts-morph';
import { assert, describe, test } from 'vitest';
import { InMemoryFileSystem } from './filesystem';
import { inspectModule, type ModuleInfo } from './inspectModule';
import { parseModule } from './staticAnalysis';
import { assertDefined } from './invariant';

function createTestSourceFile(sourceCode: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('test.ts', sourceCode);
}

describe('parseModule excludes import bindings from ambient names', () => {
  test('import from built-in module excludes binding, keeps true ambient', () => {
    const sourceFile = createTestSourceFile(`
import { readFileSync } from 'fs';
console.log(readFileSync('./foo.txt'));
`);
    const info = parseModule(sourceFile);
    assert.ok(
      !info.ambientNames.has('readFileSync'),
      'readFileSync is an import binding, not ambient',
    );
    assert.ok(info.ambientNames.has('console'));
  });

  test('import from npm package does not create ambient name', () => {
    const sourceFile = createTestSourceFile(`
import { v4 } from 'uuid';
const id = v4();
`);
    const info = parseModule(sourceFile);
    assert.ok(
      !info.ambientNames.has('v4'),
      'v4 is an import binding, not ambient',
    );
  });

  test('import from relative path does not create ambient name', () => {
    const sourceFile = createTestSourceFile(`
import { foo } from './foo';
foo();
`);
    const info = parseModule(sourceFile);
    assert.ok(
      !info.ambientNames.has('foo'),
      'foo is an import binding, not ambient',
    );
  });
});

async function createModuleInfo(
  sourceCode: string,
): Promise<ModuleInfo> {
  const files = new Map<string, string>([
    ['/repo/tsconfig.json', JSON.stringify({ compilerOptions: {} })],
    ['/repo/src/file.ts', sourceCode],
  ]);
  const fileSystem = new InMemoryFileSystem(files);
  const moduleInfo = await inspectModule('/repo', '/repo/src/file.ts', fileSystem);
  assertDefined(moduleInfo, 'Module info should be returned');
  return moduleInfo;
}

describe('inspectModule populates ambientNames', () => {
  test('ambientNames exclude import bindings, include true ambients', async () => {
    const info = await createModuleInfo(
      "import { readFileSync } from 'node:fs';\nconst x = process.cwd();\n",
    );
    assert.ok(
      !info.ambientNames.includes('readFileSync'),
      'readFileSync is an import binding, not ambient',
    );
    assert.ok(info.ambientNames.includes('process'));
  });

  test('file with only npm packages has no ambient names', async () => {
    const info = await createModuleInfo(
      "import { v4 } from 'uuid';\nexport const id = v4();\n",
    );
    assert.strictEqual(info.ambientNames.length, 0);
  });

  test('file with no imports has no ambient names', async () => {
    const info = await createModuleInfo('export const x = 1;\n');
    assert.strictEqual(info.ambientNames.length, 0);
  });
});
