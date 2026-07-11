/**
 * Bare `export { x }` re-exports of local imports must be tracked.
 *
 * `parseExportDeclaration` returned early when no module specifier was present,
 * missing patterns like:
 *   import { v4 as createUuid } from 'uuid';
 *   export { createUuid };
 *
 * These are re-exports of local bindings that originated from imports.
 * The fix resolves local names through `unresolvedExportsByImportNames` and
 * records the re-export with the original import's module specifier.
 */

import { describe, test, expect } from 'vitest';
import { InMemoryFileSystem } from './filesystem';
import { inspectModule } from './inspectModule';
import { createTestSourceFile } from './testUtils';
import { parseModule } from './staticAnalysis';

describe('parseModule tracks bare export { x } re-exports', () => {
  test('bare export of local import tracked as re-export', () => {
    const sourceFile = createTestSourceFile(`
import { foo } from './foo';
export { foo };
`);
    const info = parseModule(sourceFile);

    expect(info.reExports).toHaveLength(1);
    expect(info.reExports[0]).toMatchObject({
      name: 'foo',
      moduleSpec: './foo',
      isTypeOnly: false,
    });
    expect(info.exportedNames).toContain('foo');
  });

  test('bare export with alias tracked using exported name', () => {
    const sourceFile = createTestSourceFile(`
import { foo } from './foo';
export { foo as bar };
`);
    const info = parseModule(sourceFile);

    expect(info.reExports).toHaveLength(1);
    expect(info.reExports[0]).toMatchObject({
      name: 'bar',
      moduleSpec: './foo',
      isTypeOnly: false,
    });
    expect(info.exportedNames).toContain('bar');
  });

  test('bare type-only export tracked as type-only re-export', () => {
    const sourceFile = createTestSourceFile(`
import type { Foo } from './types';
export type { Foo };
`);
    const info = parseModule(sourceFile);

    expect(info.reExports).toHaveLength(1);
    expect(info.reExports[0]).toMatchObject({
      name: 'Foo',
      moduleSpec: './types',
      isTypeOnly: true,
    });
  });

  test('bare export of local definition not tracked as re-export', () => {
    const sourceFile = createTestSourceFile(`
const foo = 1;
export { foo };
`);
    const info = parseModule(sourceFile);

    expect(info.reExports).toHaveLength(0);
    expect(info.exportedNames).toContain('foo');
  });

  test('mixed bare export: import re-export + local export', () => {
    const sourceFile = createTestSourceFile(`
import { foo } from './foo';
const bar = 2;
export { foo, bar };
`);
    const info = parseModule(sourceFile);

    expect(info.reExports).toHaveLength(1);
    expect(info.reExports[0]).toMatchObject({
      name: 'foo',
      moduleSpec: './foo',
      isTypeOnly: false,
    });
    expect(info.exportedNames).toContain('foo');
    expect(info.exportedNames).toContain('bar');
  });

  test('mimir pattern: aliased import re-exported with local name', () => {
    /*
      Mimics mimir/common/src/util/createUuid.ts:
      import { v4 as createUuid, validate as validateUuid } from 'uuid';
      export { createUuid, validateUuid };
    */
    const sourceFile = createTestSourceFile(`
import { v4 as createUuid, validate as validateUuid } from 'uuid';
export { createUuid, validateUuid };
`);
    const info = parseModule(sourceFile);

    expect(info.reExports).toHaveLength(2);
    expect(info.reExports).toContainEqual(
      expect.objectContaining({
        name: 'createUuid',
        moduleSpec: 'uuid',
        isTypeOnly: false,
      }),
    );
    expect(info.reExports).toContainEqual(
      expect.objectContaining({
        name: 'validateUuid',
        moduleSpec: 'uuid',
        isTypeOnly: false,
      }),
    );
  });
});

describe('inspectModule resolves bare re-export paths', () => {
  test('bare re-export resolved to absolute path', async () => {
    const files = new Map<string, string>([
      ['/repo/tsconfig.json', JSON.stringify({ compilerOptions: {} })],
      ['/repo/src/foo.ts', 'export const foo = 1;\n'],
      ['/repo/src/index.ts', "import { foo } from './foo';\nexport { foo };\n"],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const moduleInfo = await inspectModule(
      '/repo',
      '/repo/src/index.ts',
      fileSystem,
    );
    expect(moduleInfo).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: not.toBeNull() guard ensures non-null at runtime
    const info = moduleInfo!;

    expect(info.reExports).toHaveLength(1);
    expect(info.reExports[0]).toMatchObject({
      name: 'foo',
      moduleSpec: './foo',
      resolvedPath: '/repo/src/foo.ts',
      isTypeOnly: false,
    });
  });

  test('bare re-export of external package has no resolvedPath', async () => {
    const files = new Map<string, string>([
      ['/repo/tsconfig.json', JSON.stringify({ compilerOptions: {} })],
      [
        '/repo/src/index.ts',
        "import { createUuid } from 'uuid';\nexport { createUuid };\n",
      ],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const moduleInfo = await inspectModule(
      '/repo',
      '/repo/src/index.ts',
      fileSystem,
    );
    expect(moduleInfo).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: not.toBeNull() guard ensures non-null at runtime
    const info = moduleInfo!;

    expect(info.reExports).toHaveLength(1);
    expect(info.reExports[0]).toMatchObject({
      name: 'createUuid',
      moduleSpec: 'uuid',
      isTypeOnly: false,
    });
    expect(info.reExports[0]).not.toHaveProperty('resolvedPath');
  });

  test('mimir pattern: aliased import re-exported — resolved paths', async () => {
    const files = new Map<string, string>([
      ['/repo/tsconfig.json', JSON.stringify({ compilerOptions: {} })],
      [
        '/repo/src/createUuid.ts',
        "import { v4 as createUuid, validate as validateUuid } from 'uuid';\nexport { createUuid, validateUuid };\n",
      ],
    ]);
    const fileSystem = new InMemoryFileSystem(files);

    const moduleInfo = await inspectModule(
      '/repo',
      '/repo/src/createUuid.ts',
      fileSystem,
    );
    expect(moduleInfo).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: not.toBeNull() guard ensures non-null at runtime
    const info = moduleInfo!;

    expect(info.reExports).toHaveLength(2);
    expect(info.reExports).toContainEqual(
      expect.objectContaining({
        name: 'createUuid',
        moduleSpec: 'uuid',
        isTypeOnly: false,
      }),
    );
    expect(info.reExports).toContainEqual(
      expect.objectContaining({
        name: 'validateUuid',
        moduleSpec: 'uuid',
        isTypeOnly: false,
      }),
    );
  });
});
