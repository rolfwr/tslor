import { assert, test } from 'vitest';
import { normalizeNamespaceImportsInFile } from './runNormalizeNamespaceImports';
import { createTestSourceFile } from './testUtils';

test('namespace access in computed property keys is normalized', () => {
  const sourceFile = createTestSourceFile(`
import * as NS from './ns';

export const obj = { [NS.key]: 'value' };
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);

  assert.lengthOf(
    changes,
    1,
    'Should produce one change for the namespace import',
  );
  // biome-ignore lint/style/noNonNullAssertion: assert.lengthOf(changes, 1) guarantees index 0 exists.
  const change = changes[0]!;
  assert.equal(change.moduleSpec, './ns');
  assert.sameMembers(change.accessedMembers, ['key']);

  const result = sourceFile.getFullText();
  assert.include(result, "import { key } from './ns'");
  assert.notInclude(result, 'import * as NS');
  assert.include(result, '[key]');
  assert.notInclude(result, 'NS.key');
});

test('namespace used directly as computed property key blocks normalization', () => {
  const sourceFile = createTestSourceFile(`
import * as NS from './ns';

export const x = NS.key;
export const obj = { [NS]: 'value' };
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);

  /*
    Normalization must be blocked because { [NS]: 'value' } would leave a
    dangling reference to NS after the namespace import is removed and
    replaced with a named import.
  */
  assert.lengthOf(
    changes,
    0,
    'Should not normalize when NS is used directly as a computed property key',
  );
});
