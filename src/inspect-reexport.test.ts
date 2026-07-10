import { assert, describe, test } from 'vitest';
import { InMemoryFileSystem } from './filesystem';
import { inspectModule } from './inspectModule';
import { assertDefined } from './invariant';

describe('inspect resolves re-export paths', () => {
  test('re-exports have resolvedPath set to absolute path', async () => {
    const fileSystem = new InMemoryFileSystem(
      new Map<string, string>([
        ['/repo/tsconfig.json', JSON.stringify({ compilerOptions: {} })],
        [
          '/repo/src/foo.ts',
          'export const foo = 1;\nexport type Foo = string;\n',
        ],
        [
          '/repo/src/index.ts',
          "export { foo } from './foo';\nexport type { Foo } from './foo';\n",
        ],
      ]),
    );

    const info = await inspectModule('/repo', '/repo/src/index.ts', fileSystem);
    assertDefined(info, 'Module info should be returned');
    assert.strictEqual(info.reExports.length, 2);

    const fooReExport = info.reExports.find((r) => r.name === 'foo');
    assert.deepStrictEqual(fooReExport, {
      name: 'foo',
      moduleSpec: './foo',
      resolvedPath: '/repo/src/foo.ts',
      isTypeOnly: false,
    });

    const fooTypeReExport = info.reExports.find((r) => r.name === 'Foo');
    assert.deepStrictEqual(fooTypeReExport, {
      name: 'Foo',
      moduleSpec: './foo',
      resolvedPath: '/repo/src/foo.ts',
      isTypeOnly: true,
    });
  });

  test('re-exports with unresolved specifiers have no resolvedPath', async () => {
    const files = new Map<string, string>([
      ['/repo/tsconfig.json', JSON.stringify({ compilerOptions: {} })],
      ['/repo/src/index.ts', "export { something } from 'external-package';\n"],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const info = await inspectModule('/repo', '/repo/src/index.ts', fileSystem);
    assertDefined(info, 'Module info should be returned');
    assert.strictEqual(info.reExports.length, 1);

    const reExport = info.reExports.at(0);
    assert.deepStrictEqual(reExport, {
      name: 'something',
      moduleSpec: 'external-package',
      isTypeOnly: false,
    });
  });
});
