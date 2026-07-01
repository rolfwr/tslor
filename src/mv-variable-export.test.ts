import { assert, describe, test } from 'vitest';
import { join } from 'node:path';
import { InMemoryFileSystem } from './filesystem';
import { getFixups } from './runMv';

describe('mv variable export tracking', () => {
  test('getFixups tracks export const symbols', async () => {
    const srcPath = join('/project/src', 'moved.ts');
    const oldPath = join('/project/src', 'original.ts');

    const files = new Map<string, string>([[srcPath, 'export const x = 1;\n']]);
    const fileSystem = new InMemoryFileSystem(files);

    const fixups = await getFixups(srcPath, oldPath, fileSystem);

    assert.strictEqual(fixups.length, 1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion guarantees index 0 exists
    const fixup = fixups[0]!;
    assert.strictEqual(fixup.oldExport.name, 'x');
    assert.strictEqual(fixup.newExport.name, 'x');
    assert.strictEqual(fixup.oldExport.path, oldPath);
    assert.strictEqual(fixup.newExport.path, srcPath);
  });

  test('getFixups tracks multiple exports in a single const statement', async () => {
    /*
      `export const a = 1, b = 2;` produces two VariableDeclarations
      inside one VariableStatement. Both must be tracked.
    */
    const srcPath = join('/project/src', 'moved.ts');
    const oldPath = join('/project/src', 'original.ts');

    const files = new Map<string, string>([
      [srcPath, 'export const a = 1, b = 2;\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const fixups = await getFixups(srcPath, oldPath, fileSystem);

    assert.strictEqual(fixups.length, 2);
    const names = fixups.map((f) => f.newExport.name).sort();
    assert.deepEqual(names, ['a', 'b']);
  });

  test('getFixups ignores non-exported const declarations', async () => {
    const srcPath = join('/project/src', 'moved.ts');
    const oldPath = join('/project/src', 'original.ts');

    const files = new Map<string, string>([
      [srcPath, 'const internal = 42;\nexport const exported = 1;\n'],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const fixups = await getFixups(srcPath, oldPath, fileSystem);

    assert.strictEqual(fixups.length, 1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion guarantees index 0 exists
    const fixup = fixups[0]!;
    assert.strictEqual(fixup.newExport.name, 'exported');
  });

  test('getFixups tracks mixed exports (const + function + interface)', async () => {
    const srcPath = join('/project/src', 'moved.ts');
    const oldPath = join('/project/src', 'original.ts');

    const files = new Map<string, string>([
      [
        srcPath,
        `
export const CONFIG = 'value';
export function helper(): string { return ''; }
export interface Item { id: string; }
`,
      ],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const fixups = await getFixups(srcPath, oldPath, fileSystem);

    assert.strictEqual(fixups.length, 3);
    const names = fixups.map((f) => f.newExport.name).sort();
    assert.deepEqual(names, ['CONFIG', 'Item', 'helper']);
  });
});
