import { test, assert } from 'vitest';
import { replaceTypeInFile } from './runReplaceTypeUse';

function replace(body: string): string | null {
  const content = `import type { Item } from './source';\n${body}`;
  return replaceTypeInFile('/test.ts', content, 'Item', 'NewItem', './source', './target');
}

test('type reference on export line should be replaced', () => {
  const result = replace('export const x: Item = {};');
  assert.isNotNull(result);
  assert.include(result!, 'export const x: NewItem = {};');
});

test('type name inside string literal should not be replaced', () => {
  const result = replace('const x: Item = {};\nlogger.info("Item not found");');
  assert.isNotNull(result);
  assert.include(result!, 'const x: NewItem = {};');
  assert.include(result!, '"Item not found"');
});

test('type name inside comment should not be replaced', () => {
  const result = replace('const x: Item = {};\n// Before a Item is processed');
  assert.isNotNull(result);
  assert.include(result!, 'const x: NewItem = {};');
  assert.include(result!, '// Before a Item is processed');
});

test('sole import preserves deeper relative path when target module equals source module', () => {
  const content = `import type { Item } from '../entity/item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/src/live/liveResource.ts', content,
    'Item', 'ItemEntity',
    './entity/item', './entity/item'
  );
  assert.isNotNull(result);
  assert.include(result!, "from '../entity/item'");
  assert.notInclude(result!, "from './entity/item'");
});

test('shared import preserves deeper relative path on both lines', () => {
  const content = `import type { Item, PendingArchiveRequest } from '../../entity/item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/src/mappers/interfaces/itemMapperOps.ts', content,
    'Item', 'ItemEntity',
    './entity/item', './entity/item'
  );
  assert.isNotNull(result);
  assert.include(result!, "{ PendingArchiveRequest } from '../../entity/item'");
  assert.include(result!, "{ ItemEntity } from '../../entity/item'");
  assert.notInclude(result!, "from './entity/item'");
});

test('different target module computes correct relative path', () => {
  const content = `import type { Item } from '../entity/item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/src/live/liveResource.ts', content,
    'Item', 'NewItem',
    './entity/item', './entity/newItem'
  );
  assert.isNotNull(result);
  assert.include(result!, "from '../entity/newItem'");
});

test('package specifier is preserved as-is', () => {
  const content = `import type { Item } from '@pkg/entity/item';\nconst x: Item = {};`;
  const result = replaceTypeInFile(
    '/repo/src/live/liveResource.ts', content,
    'Item', 'ItemEntity',
    '@pkg/entity/item', '@pkg/entity/item'
  );
  assert.isNotNull(result);
  assert.include(result!, "from '@pkg/entity/item'");
});
