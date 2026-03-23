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
