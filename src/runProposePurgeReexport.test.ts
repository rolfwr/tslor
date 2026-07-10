import { assert, test } from 'vitest';
import { Project } from 'ts-morph';
import {
  applyReexportRemovalsToFile,
  filterReExportsByDirectory,
  hasPublicTag,
} from './runProposePurgeReexport';
import { parseModule } from './staticAnalysis';
import { createTestSourceFile } from './testUtils';

test('applyReexportRemovalsToFile preserves type keyword for individual exports', () => {
  const source = `
export {
  ValueExport1,
  ValueExport2,
  type TypeExport1,
  type TypeExport2,
  UnusedValue,
  type UnusedType
} from './mixed';
`;

  const sourceFile = createTestSourceFile(source);

  // Remove some exports but keep the mixed type/value nature
  const reExportsToRemove = [
    {
      reExporterPath: 'test.ts',
      symbolName: 'UnusedValue',
      originalModuleSpec: './mixed',
      isTypeOnly: false,
    },
    {
      reExporterPath: 'test.ts',
      symbolName: 'UnusedType',
      originalModuleSpec: './mixed',
      isTypeOnly: true,
    },
  ];

  applyReexportRemovalsToFile(sourceFile, reExportsToRemove, 'test.ts');

  const result = sourceFile.getFullText();

  // Should preserve the type keyword for type-only exports
  assert.include(
    result,
    'type TypeExport1',
    'Should preserve type keyword for TypeExport1',
  );
  assert.include(
    result,
    'type TypeExport2',
    'Should preserve type keyword for TypeExport2',
  );

  // Should keep value exports without type keyword
  assert.include(result, 'ValueExport1');
  assert.include(result, 'ValueExport2');

  // Should remove unused exports
  assert.notInclude(result, 'UnusedValue');
  assert.notInclude(result, 'UnusedType');
});

test('applyReexportRemovalsToFile removes unused re-exports', () => {
  const source = `
import { helper } from './utils';

export { formatDate } from './date-utils';
export type { ItemDto, UnusedType } from './types';
export { usedFunction, unusedFunction } from './functions';

export function localFunction(): void {
  helper();
}
`;

  const sourceFile = createTestSourceFile(source);

  // Simulate removing specific re-exports
  const reExportsToRemove = [
    {
      reExporterPath: 'test.ts',
      symbolName: 'formatDate',
      originalModuleSpec: './date-utils',
      isTypeOnly: false,
    },
    {
      reExporterPath: 'test.ts',
      symbolName: 'UnusedType',
      originalModuleSpec: './types',
      isTypeOnly: true,
    },
    {
      reExporterPath: 'test.ts',
      symbolName: 'unusedFunction',
      originalModuleSpec: './functions',
      isTypeOnly: false,
    },
  ];

  applyReexportRemovalsToFile(sourceFile, reExportsToRemove, 'test.ts');

  const result = sourceFile.getFullText();

  // Should remove formatDate from the first export declaration (completely)
  assert.notInclude(result, "export { formatDate } from './date-utils';");

  // Should keep the type export but remove UnusedType, leaving only ItemDto
  assert.include(result, "export type { ItemDto } from './types';");
  assert.notInclude(result, 'UnusedType');

  // Should keep the value export but remove unusedFunction, leaving only usedFunction
  assert.include(result, "export { usedFunction } from './functions';");
  assert.notInclude(result, 'unusedFunction');

  // Should keep the import and local function
  assert.include(result, "import { helper } from './utils';");
  assert.include(result, 'export function localFunction()');
});

test('applyReexportRemovalsToFile removes entire export declaration when all symbols unused', () => {
  const source = `
export { usedFunction } from './functions';
export type { UnusedType1, UnusedType2 } from './types';
export { anotherUsed } from './other';
`;

  const sourceFile = createTestSourceFile(source);

  // Remove all symbols from the type export declaration
  const reExportsToRemove = [
    {
      reExporterPath: 'test.ts',
      symbolName: 'UnusedType1',
      originalModuleSpec: './types',
      isTypeOnly: true,
    },
    {
      reExporterPath: 'test.ts',
      symbolName: 'UnusedType2',
      originalModuleSpec: './types',
      isTypeOnly: true,
    },
  ];

  applyReexportRemovalsToFile(sourceFile, reExportsToRemove, 'test.ts');

  const result = sourceFile.getFullText();

  // Should remove the entire type export declaration
  assert.notInclude(
    result,
    "export type { UnusedType1, UnusedType2 } from './types';",
  );

  // Should keep the other exports
  assert.include(result, "export { usedFunction } from './functions';");
  assert.include(result, "export { anotherUsed } from './other';");
});

test('hasPublicTag detects /** @public */ on export declaration', () => {
  const source = `
/** @public */
export { delegateAuthorize } from './auth';
export { unusedHelper } from './helpers';
`;
  const sourceFile = createTestSourceFile(source);
  const exportDecls = sourceFile.getExportDeclarations();

  const [first, second] = exportDecls;
  if (first === undefined) {
    throw new Error('Expected first export declaration');
  }
  if (second === undefined) {
    throw new Error('Expected second export declaration');
  }
  assert.isTrue(
    hasPublicTag(first),
    'First export should be detected as @public',
  );
  assert.isFalse(
    hasPublicTag(second),
    'Second export should not be detected as @public',
  );
});

test('hasPublicTag returns false when no JSDoc is present', () => {
  const source = `
export { foo } from './foo';
export { bar } from './bar';
`;
  const sourceFile = createTestSourceFile(source);
  const exportDecls = sourceFile.getExportDeclarations();

  const [first, second] = exportDecls;
  if (first === undefined) {
    throw new Error('Expected first export declaration');
  }
  if (second === undefined) {
    throw new Error('Expected second export declaration');
  }
  assert.isFalse(hasPublicTag(first));
  assert.isFalse(hasPublicTag(second));
});

test('hasPublicTag detects @public among other tags', () => {
  const source = `
/**
 * @public @deprecated Use newAuth instead
 */
export { oldAuth } from './auth';
`;
  const sourceFile = createTestSourceFile(source);
  const exportDecls = sourceFile.getExportDeclarations();

  const [first] = exportDecls;
  if (first === undefined) {
    throw new Error('Expected first export declaration');
  }
  assert.isTrue(hasPublicTag(first));
});

test('hasPublicTag detects @public in single-line comment', () => {
  const source = `
// @public
export { handler } from './handler';
`;
  const sourceFile = createTestSourceFile(source);
  const exportDecls = sourceFile.getExportDeclarations();

  const [first] = exportDecls;
  if (first === undefined) {
    throw new Error('Expected first export declaration');
  }
  assert.isTrue(hasPublicTag(first));
});

test('parseModule tracks namespace imports (import * as X) in unresolvedExportsByImportNames', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'consumer.ts',
    `
import * as initialValues from './initialValues';

export function init() {
  return initialValues.supportedOps;
}
`,
  );

  const moduleInfo = parseModule(sourceFile);

  // The namespace import should be tracked with a '*' sentinel name
  const nsEntry =
    moduleInfo.unresolvedExportsByImportNames.get('initialValues');
  assert.isDefined(
    nsEntry,
    'Namespace import "initialValues" should be in unresolvedExportsByImportNames',
  );
  if (nsEntry === undefined) {
    throw new Error('Expected nsEntry');
  }
  assert.equal(
    nsEntry.name,
    '*',
    'Namespace import should use "*" as the export name',
  );
  assert.equal(
    nsEntry.moduleSpec,
    './initialValues',
    'Should record the correct module specifier',
  );

  // The imports array should also contain an entry
  const nsImport = moduleInfo.imports.find(
    (imp) => imp.moduleSpec === './initialValues',
  );
  assert.isDefined(
    nsImport,
    'Should have an import entry for the namespace import',
  );
  if (nsImport === undefined) {
    throw new Error('Expected nsImport');
  }
  assert.include(nsImport.names, '*', 'Import names should include "*"');
});

test('filterReExportsByDirectory keeps only re-exports within the target directory', () => {
  const reExports = [
    {
      reExporterPath: '/repo/src/api/index.ts',
      symbolName: 'foo',
      originalModuleSpec: './foo',
      isTypeOnly: false,
    },
    {
      reExporterPath: '/repo/src/api/types.ts',
      symbolName: 'Bar',
      originalModuleSpec: './bar',
      isTypeOnly: true,
    },
    {
      reExporterPath: '/repo/src/core/index.ts',
      symbolName: 'baz',
      originalModuleSpec: './baz',
      isTypeOnly: false,
    },
    {
      reExporterPath: '/repo/src/other/util.ts',
      symbolName: 'qux',
      originalModuleSpec: './qux',
      isTypeOnly: false,
    },
  ];
  const directory = '/repo/src/api';

  const filtered = filterReExportsByDirectory(reExports, directory);

  assert.lengthOf(
    filtered,
    2,
    'Should keep only re-exports within /repo/src/api',
  );
  // biome-ignore lint/style/noNonNullAssertion: assert.lengthOf(filtered, 2) guarantees indices 0 and 1 exist.
  const first = filtered.at(0)!;
  // biome-ignore lint/style/noNonNullAssertion: assert.lengthOf(filtered, 2) guarantees indices 0 and 1 exist.
  const second = filtered.at(1)!;
  assert.equal(first.symbolName, 'foo');
  assert.equal(second.symbolName, 'Bar');
});

test('filterReExportsByDirectory returns empty array when no re-exports match directory', () => {
  const reExports = [
    {
      reExporterPath: '/repo/src/core/index.ts',
      symbolName: 'baz',
      originalModuleSpec: './baz',
      isTypeOnly: false,
    },
  ];
  const directory = '/repo/src/api';

  const filtered = filterReExportsByDirectory(reExports, directory);

  assert.lengthOf(filtered, 0, 'Should return empty when no re-exports match');
});

test('filterReExportsByDirectory returns all re-exports when directory is repo root', () => {
  const reExports = [
    {
      reExporterPath: '/repo/src/api/index.ts',
      symbolName: 'foo',
      originalModuleSpec: './foo',
      isTypeOnly: false,
    },
    {
      reExporterPath: '/repo/src/core/index.ts',
      symbolName: 'baz',
      originalModuleSpec: './baz',
      isTypeOnly: false,
    },
  ];
  const directory = '/repo';

  const filtered = filterReExportsByDirectory(reExports, directory);

  assert.lengthOf(
    filtered,
    2,
    'Should keep all re-exports when directory is the repo root',
  );
});

test('filterReExportsByDirectory: must not match prefix without separator guard', () => {
  /*
    Bare String.startsWith() produces false positives:
    "/repo/src/api2/index.ts".startsWith("/repo/src/api") is true, but the file
    is NOT inside directory "/repo/src/api".
  */
  const reExports = [
    {
      reExporterPath: '/repo/src/api2/index.ts',
      symbolName: 'falsePositive',
      originalModuleSpec: './fp',
      isTypeOnly: false,
    },
    {
      reExporterPath: '/repo/src/api/index.ts',
      symbolName: 'realMatch',
      originalModuleSpec: './rm',
      isTypeOnly: false,
    },
    {
      reExporterPath: '/repo/src/api_types/index.ts',
      symbolName: 'alsoFalse',
      originalModuleSpec: './af',
      isTypeOnly: false,
    },
  ];
  const directory = '/repo/src/api';

  const filtered = filterReExportsByDirectory(reExports, directory);

  assert.lengthOf(
    filtered,
    1,
    'Should keep only the re-export truly inside /repo/src/api',
  );
  // biome-ignore lint/style/noNonNullAssertion: assert.lengthOf(filtered, 1) guarantees index 0 exists.
  const first = filtered.at(0)!;
  assert.equal(
    first.symbolName,
    'realMatch',
    'Only the real match should remain',
  );
});

test('filterReExportsByDirectory: mimir/mimir2 false positive must be rejected', () => {
  /*
    Canonical prefix-matching bug:
    "/home/repos/mimir2/src/index.ts".startsWith("/home/repos/mimir") is true
    but the file is NOT inside "/home/repos/mimir".
  */
  const reExports = [
    {
      reExporterPath: '/home/repos/mimir2/src/index.ts',
      symbolName: 'wrong',
      originalModuleSpec: './x',
      isTypeOnly: false,
    },
    {
      reExporterPath: '/home/repos/mimir/src/index.ts',
      symbolName: 'correct',
      originalModuleSpec: './y',
      isTypeOnly: false,
    },
  ];
  const directory = '/home/repos/mimir';

  const filtered = filterReExportsByDirectory(reExports, directory);

  assert.lengthOf(
    filtered,
    1,
    'Must not match mimir2 when filtering for mimir',
  );
  // biome-ignore lint/style/noNonNullAssertion: assert.lengthOf(filtered, 1) guarantees index 0 exists.
  const first = filtered.at(0)!;
  assert.equal(first.symbolName, 'correct');
});
