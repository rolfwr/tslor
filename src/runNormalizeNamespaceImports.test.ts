import { assert, test } from 'vitest';
import { Project } from 'ts-morph';
import { normalizeNamespaceImportsInFile } from './runNormalizeNamespaceImports';

function createTestSourceFile(sourceCode: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('test.ts', sourceCode);
}

test('normalizeNamespaceImportsInFile converts import * as X to named imports', () => {
  const sourceFile = createTestSourceFile(`
import * as utils from './utils';

export function doStuff() {
  return utils.foo() + utils.bar;
}
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);

  assert.lengthOf(changes, 1, 'Should produce one change for one namespace import');
  const change = changes[0];
  assert.equal(change.moduleSpec, './utils');
  assert.sameMembers(change.accessedMembers, ['foo', 'bar']);

  const result = sourceFile.getFullText();
  assert.include(result, "import { bar, foo } from './utils'");
  assert.notInclude(result, 'import * as utils');
  assert.include(result, 'foo()');
  assert.include(result, 'bar');
  assert.notInclude(result, 'utils.foo');
  assert.notInclude(result, 'utils.bar');
});

test('normalizeNamespaceImportsInFile handles multiple namespace imports', () => {
  const sourceFile = createTestSourceFile(`
import * as a from './a';
import * as b from './b';

export const x = a.one + b.two;
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);
  assert.lengthOf(changes, 2);

  const result = sourceFile.getFullText();
  assert.include(result, "import { one } from './a'");
  assert.include(result, "import { two } from './b'");
  assert.notInclude(result, 'import * as');
  assert.include(result, 'one + two');
});

test('normalizeNamespaceImportsInFile preserves type-only namespace imports', () => {
  const sourceFile = createTestSourceFile(`
import type * as types from './types';

export function process(x: types.Foo): types.Bar {
  return x as types.Bar;
}
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);
  assert.lengthOf(changes, 1);

  const result = sourceFile.getFullText();
  assert.include(result, "import type { Bar, Foo } from './types'");
  assert.notInclude(result, 'import type * as types');
  assert.include(result, 'x: Foo');
  assert.include(result, ': Bar');
});

test('normalizeNamespaceImportsInFile leaves non-namespace imports alone', () => {
  const sourceFile = createTestSourceFile(`
import { foo } from './utils';
import defaultExport from './other';

export const x = foo() + defaultExport;
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);
  assert.lengthOf(changes, 0, 'Should not change named or default imports');
});

test('normalizeNamespaceImportsInFile skips namespace imports with no member access', () => {
  const sourceFile = createTestSourceFile(`
import * as utils from './utils';

// namespace passed as a whole value — can't safely normalize
export const x = doSomething(utils);
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);
  assert.lengthOf(changes, 0, 'Should skip when namespace is used as a value, not just member access');
});

test('normalizeNamespaceImportsInFile handles name conflicts by skipping', () => {
  const sourceFile = createTestSourceFile(`
import * as utils from './utils';

const foo = 'local';
export const x = utils.foo + foo;
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);
  assert.lengthOf(changes, 0, 'Should skip when a member name conflicts with a local binding');
});

test('normalizeNamespaceImportsInFile uses inline type keyword for type-only members in mixed imports', () => {
  const sourceFile = createTestSourceFile(`
import * as dtos from './dtos';

export function claimRequest(request: dtos.ClaimRequestDto): dtos.ResponseDto | null {
  if (!dtos.isValidRequest(request)) {
    return null;
  }
  return { ok: true } as dtos.ResponseDto;
}
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);
  assert.lengthOf(changes, 1);

  const result = sourceFile.getFullText();
  /*
    ClaimRequestDto and ResponseDto are only used in type positions (QualifiedName)
    isValidRequest is used in value position (PropertyAccessExpression)
  */
  assert.include(result, "import { type ClaimRequestDto, type ResponseDto, isValidRequest } from './dtos'");
  assert.notInclude(result, 'import * as dtos');
});

test('normalizeNamespaceImportsInFile detects name conflicts inside nested scopes', () => {
  const sourceFile = createTestSourceFile(`
import * as testData from './data';

export function test() {
  const updateEvent = cloneDeep(testData.updateEvent);
  return updateEvent;
}
`);

  const changes = normalizeNamespaceImportsInFile(sourceFile);
  assert.lengthOf(changes, 0, 'Should skip when a member name conflicts with a nested variable');

  // Source should be unchanged
  const result = sourceFile.getFullText();
  assert.include(result, 'import * as testData');
  assert.include(result, 'testData.updateEvent');
});
