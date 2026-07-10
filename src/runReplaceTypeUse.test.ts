import { test, assert } from 'vitest';
import { replaceTypeInFile } from './runReplaceTypeUse';

function replace(body: string): string | null {
  const content = `import type { Item } from './source';\n${body}`;
  return replaceTypeInFile(
    '/test.ts',
    content,
    'Item',
    'NewItem',
    './source',
    './target',
  );
}

// RATIONALE: test helper — test file signatures exempted by convention
function must<T>(value: T | null | undefined,
  // ast-grep-ignore: no-optional-param
  msg?: string,
): T {
  if (value === null || value === undefined) {
    throw new Error(msg ?? 'Expected value');
  }
  return value;
}

test('type reference on export line should be replaced', () => {
  const result = replace('export const x: Item = {};');
  assert.isNotNull(result);
  assert.include(must(result), 'export const x: NewItem = {};');
});

test('type name inside string literal should not be replaced', () => {
  const result = replace('const x: Item = {};\nlogger.info("Item not found");');
  assert.isNotNull(result);
  assert.include(must(result), 'const x: NewItem = {};');
  assert.include(must(result), '"Item not found"');
});

test('type name inside comment should not be replaced', () => {
  const result = replace('const x: Item = {};\n// Before a Item is processed');
  assert.isNotNull(result);
  assert.include(must(result), 'const x: NewItem = {};');
  assert.include(must(result), '// Before a Item is processed');
});

test('sole import preserves deeper relative path when target module equals source module', () => {
  const content = `import type { Item } from '../entity/item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/src/live/liveResource.ts',
    content,
    'Item',
    'ItemEntity',
    './entity/item',
    './entity/item',
  );
  assert.isNotNull(result);
  assert.include(must(result), "from '../entity/item'");
  assert.notInclude(must(result), "from './entity/item'");
});

test('shared import preserves deeper relative path on both lines', () => {
  const content = `import type { Item, PendingArchiveRequest } from '../../entity/item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/src/mappers/interfaces/itemMapperOps.ts',
    content,
    'Item',
    'ItemEntity',
    './entity/item',
    './entity/item',
  );
  assert.isNotNull(result);
  assert.include(
    must(result),
    "{ PendingArchiveRequest } from '../../entity/item'",
  );
  assert.include(must(result), "{ ItemEntity } from '../../entity/item'");
  assert.notInclude(must(result), "from './entity/item'");
});

test('different target module computes correct relative path', () => {
  const content = `import type { Item } from '../entity/item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/src/live/liveResource.ts',
    content,
    'Item',
    'NewItem',
    './entity/item',
    './entity/newItem',
  );
  assert.isNotNull(result);
  assert.include(must(result), "from '../entity/newItem'");
});

test('relative import matches when source-module is a package specifier (same target module)', () => {
  /*
    Files that use relative imports (e.g. `./item`) for a type whose source module
    is a package specifier (e.g. `@pkg/entity/item`) must be matched and transformed.
    When the target module equals the source module, the original relative path is
    preserved rather than replaced with the package specifier.
  */
  const content = `import type { Item } from './item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/packages/server-common/src/entity/itemCharacteristics.ts',
    content,
    'Item',
    'ItemEntity',
    '@pkg/entity/item',
    '@pkg/entity/item',
    '/repo/packages/server-common/src/entity/item.ts',
  );
  assert.isNotNull(result);
  assert.include(must(result), 'ItemEntity');
  // Relative path must be preserved, not replaced with the package specifier
  assert.include(must(result), "from './item'");
  assert.notInclude(must(result), '@pkg');
});

test('relative import matches when source and target are different package modules', () => {
  const content = `import type { Item } from './item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/packages/server-common/src/entity/itemCharacteristics.ts',
    content,
    'Item',
    'NewItem',
    '@pkg/entity/item',
    '@pkg/entity/newItem',
    '/repo/packages/server-common/src/entity/item.ts',
  );
  assert.isNotNull(result);
  assert.include(must(result), 'NewItem');
  // When target is a different package module, use the package specifier
  assert.include(must(result), "from '@pkg/entity/newItem'");
});

test('does not match same-named symbol from a different module', () => {
  /*
    File imports Item from searchResultHit, NOT from entity/item.
    The exporter path is from the wrong module — should be rejected.
  */
  const content = `import type { Item } from '../dto/searchResultHit';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/common/src/item/media.ts',
    content,
    'Item',
    'ItemEntity',
    '@mimir/server-common/entity/item',
    '@mimir/server-common/entity/item',
    '/repo/common/src/dto/searchResultHit.ts',
  );
  assert.isNull(result);
});

test('inline type keyword in mixed imports is recognized', () => {
  /*
    TypeScript 4.5+ allows `import { type X }` syntax. The source type
    must be recognized even when prefixed with `type` inside a mixed import,
    separated into its own `import type` line, and all body references updated.
  */
  const content = `import { OtherName, type Item } from './source';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/test.ts',
    content,
    'Item',
    'NewItem',
    './source',
    './target',
  );
  assert.isNotNull(result);
  // Original import must be split: OtherName kept, Item removed
  assert.include(must(result), 'import { OtherName } from');
  // New type import added for renamed symbol
  assert.include(must(result), 'import type { NewItem } from');
  // Original import line must not remain unchanged
  assert.notInclude(must(result), '{ OtherName, type Item }');
  assert.include(must(result), 'const x: NewItem');
});

test('re-export lines are updated alongside imports', () => {
  /*
    Re-exports (`export { X } from '...'`) must be updated with the new symbol
    name and target module path. The original import is removed, and body type
    references are replaced.
  */
  const content = `export { Item } from './source';\nimport { Item } from './source';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/test.ts',
    content,
    'Item',
    'NewItem',
    './source',
    './target',
  );
  assert.isNotNull(result);
  // Re-export must be updated with new name AND new module path
  assert.include(must(result), "export { NewItem } from './target'");
  // Old import should be removed
  assert.notInclude(must(result), 'import { Item }');
  // Body type reference must also be replaced after import splice
  assert.include(must(result), 'const x: NewItem');
});

test('package specifier is preserved as-is', () => {
  const content = `import type { Item } from '@pkg/entity/item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/src/live/liveResource.ts',
    content,
    'Item',
    'ItemEntity',
    '@pkg/entity/item',
    '@pkg/entity/item',
  );
  assert.isNotNull(result);
  assert.include(must(result), "from '@pkg/entity/item'");
});

test('export line with source type name and from in body is not treated as re-export', () => {
  /*
    Export type declarations whose name contains the source type and whose body
    contains the word "from" (e.g. `export type ItemFromSource = { from: string }`)
    must not be mistaken for re-exports.
  */
  const content = `import type { Item } from './source';\nexport type ItemFromSource = { from: string };\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/test.ts',
    content,
    'Item',
    'NewItem',
    './source',
    './target',
  );
  assert.isNotNull(result);
  // The export type declaration should be untouched
  assert.include(must(result), 'export type ItemFromSource = { from: string }');
  // Import and body should still be transformed
  assert.include(must(result), 'import type { NewItem }');
  assert.include(must(result), 'const x: NewItem');
});

test('re-export detected when it appears after the import line', () => {
  /*
    Re-exports must be detected regardless of whether they appear before or
    after the corresponding import line.
  */
  const content = `import { Item } from './source';\nexport { Item } from './source';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/test.ts',
    content,
    'Item',
    'NewItem',
    './source',
    './target',
  );
  assert.isNotNull(result);
  // Re-export must be updated
  assert.include(must(result), "export { NewItem } from './target'");
  // Old import should be removed
  assert.notInclude(must(result), 'import { Item }');
  // Body type reference replaced
  assert.include(must(result), 'const x: NewItem');
});

test('re-export with other import names preserves the import for remaining names', () => {
  /*
    When the import line carries symbols other than the source type, the import
    must be preserved (with the source type stripped) rather than removed entirely.
  */
  const content = `import { Item, Other } from './source';\nexport { Item } from './source';\nconst x: Item = {};\nconst y: Other = {};`;
  const result = replaceTypeInFile(
    '/test.ts',
    content,
    'Item',
    'NewItem',
    './source',
    './target',
  );
  assert.isNotNull(result);
  // Re-export must be updated
  assert.include(must(result), "export { NewItem } from './target'");
  // Import must be preserved for 'Other'
  assert.include(must(result), "import { Other } from './source'");
  // Source type must not remain in the import
  assert.notInclude(must(result), 'import { Item');
  assert.notInclude(must(result), 'import { Other, Item');
  // Body type references replaced
  assert.include(must(result), 'const x: NewItem');
  assert.include(must(result), 'const y: Other');
});
