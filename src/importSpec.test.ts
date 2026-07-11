import { assert, test } from 'vitest';
import { modulePathToImportSpecAlias } from './importSpec';
import { parseIsolatedSourceCode } from './testUtils';
import { getOrThrow } from './invariant';

test('importSpec', () => {
  const testCase = {
    compilerOptions: {
      paths: {
        '@acme/shared/*': ['../../../shared/src/*'],
        '@acme/backend-shared/*': ['../../../packages/backend-shared/src/*'],
        '@acme/main/*': ['./*'],
      },
      baseUrl: 'src',
      rootDir: '.',
    },
    tsconfigDir: '/home/user/projects/acme/backend/main',
    modulePath:
      '/home/user/projects/acme/packages/backend-shared/src/mutate/transform.ts',
  };

  const result = modulePathToImportSpecAlias(
    testCase.compilerOptions,
    testCase.tsconfigDir,
    testCase.modulePath,
  );
  assert.equal(result, '@acme/backend-shared/mutate/transform');
});

test('Parse imports', () => {
  const info = parseIsolatedSourceCode(
    "import { foo, bar } from './baz';\nimport { spam, ham } from 'eggs';\n",
  );

  const importNames = info.unresolvedExportsByImportNames.keys();
  assert.deepEqual([...importNames], ['foo', 'bar', 'spam', 'ham']);
  assert.deepEqual(info.unresolvedExportsByImportNames.get('foo'), {
    moduleSpec: './baz',
    name: 'foo',
    isTypeOnly: false,
  });
  assert.deepEqual(info.unresolvedExportsByImportNames.get('bar'), {
    moduleSpec: './baz',
    name: 'bar',
    isTypeOnly: false,
  });
  assert.deepEqual(info.unresolvedExportsByImportNames.get('spam'), {
    moduleSpec: 'eggs',
    name: 'spam',
    isTypeOnly: false,
  });
  assert.deepEqual(info.unresolvedExportsByImportNames.get('ham'), {
    moduleSpec: 'eggs',
    name: 'ham',
    isTypeOnly: false,
  });
});

test('Parse exported variable', () => {
  const info = parseIsolatedSourceCode(
    'export const foo = 42;\nconst bar = 69;\n',
  );
  assert.ok(info.exportedNames.has('foo'));
  assert.ok(!info.exportedNames.has('bar'));
});

test('Parse exported function', () => {
  const info = parseIsolatedSourceCode(
    "export function greet() {\n  console.log('Hello!');\n}\n",
  );
  assert.ok(info.exportedNames.has('greet'));
});

test('Parse function using imports', () => {
  const info = parseIsolatedSourceCode(
    "import { answer } from './mystery';\n\nexport function getAnswer(): number {\n  return answer;\n}\n",
  );
  const expectedImports = [
    { moduleSpec: './mystery', names: ['answer'], typeOnly: false },
  ];
  assert.deepEqual(info.imports, expectedImports);
  assert.ok(info.exportedNames.has('getAnswer'));

  const getAnswerUses = getOrThrow(
    info.identifierUses,
    'getAnswer',
    'getAnswer identifier uses should be tracked',
  );
  assert.include(getAnswerUses, 'answer');
});

test('Parse transitive import use', () => {
  const src = `
import { stat } from './myfs';
import { join } from './mypath';

function foo() {
  return join('hello', 'world');
}

export function baz() {
  return new Promise((resolve, reject) => {
    stat('path', (err, stats) => {
      if (err) {
        reject(err);
      } else {
        resolve(stats);
      }
    });
  });
}

export function qux() {
  return foo();
}
`;

  const info = parseIsolatedSourceCode(src);
  const expectedImports = [
    { moduleSpec: './myfs', names: ['stat'], typeOnly: false },
    { moduleSpec: './mypath', names: ['join'], typeOnly: false },
  ];
  assert.deepEqual(info.imports, expectedImports);
  assert.ok(info.exportedNames.has('baz'));
  assert.ok(info.exportedNames.has('qux'));

  const bazUses = getOrThrow(
    info.identifierUses,
    'baz',
    'baz identifier uses should be tracked',
  );
  assert.include(bazUses, 'stat');

  const quxUses = getOrThrow(
    info.identifierUses,
    'qux',
    'qux identifier uses should be tracked',
  );
  assert.deepEqual(quxUses, ['foo']);

  const fooUses = getOrThrow(
    info.identifierUses,
    'foo',
    'foo identifier uses should be tracked',
  );
  assert.deepEqual(fooUses, ['join']);
});

test('Parse import aliases correctly', () => {
  const src = `
import { format as formatDate, parse as parseDate } from 'date-fns';
import { join as pathJoin } from 'path';

export function processFile(filename: string, content: string): string {
  const parsed = parseDate(content);
  const formatted = formatDate(parsed);
  const fullPath = pathJoin('/tmp', filename);
  return fullPath + ': ' + formatted;
}
`;

  const info = parseIsolatedSourceCode(src);

  // Should correctly map local names to original export names
  const expectedImports = [
    { moduleSpec: 'date-fns', names: ['format', 'parse'], typeOnly: false },
    { moduleSpec: 'path', names: ['join'], typeOnly: false },
  ];
  assert.deepEqual(info.imports, expectedImports);

  // unresolvedExportsByImportNames should map local names to original export names
  assert.equal(
    info.unresolvedExportsByImportNames.get('formatDate')?.name,
    'format',
  );
  assert.equal(
    info.unresolvedExportsByImportNames.get('formatDate')?.moduleSpec,
    'date-fns',
  );
  assert.equal(
    info.unresolvedExportsByImportNames.get('parseDate')?.name,
    'parse',
  );
  assert.equal(
    info.unresolvedExportsByImportNames.get('parseDate')?.moduleSpec,
    'date-fns',
  );
  assert.equal(
    info.unresolvedExportsByImportNames.get('pathJoin')?.name,
    'join',
  );
  assert.equal(
    info.unresolvedExportsByImportNames.get('pathJoin')?.moduleSpec,
    'path',
  );

  // identifierUses should use the local aliased names
  const processFileUses = getOrThrow(
    info.identifierUses,
    'processFile',
    'processFile identifier uses should be tracked',
  );
  assert.include(processFileUses, 'parseDate');
  assert.include(processFileUses, 'formatDate');
  assert.include(processFileUses, 'pathJoin');
});

test('Parse namespace imports correctly', () => {
  const src = `
import * as fs from 'fs';
import * as path from 'path';

export function readConfig(filename: string): string {
  const fullPath = path.join('/config', filename);
  return fs.readFileSync(fullPath, 'utf-8');
}
`;

  const info = parseIsolatedSourceCode(src);

  // Should handle namespace imports
  const expectedImports = [
    { moduleSpec: 'fs', names: ['*'], typeOnly: false },
    { moduleSpec: 'path', names: ['*'], typeOnly: false },
  ];
  assert.deepEqual(info.imports, expectedImports);

  // Should track namespace usage
  const readConfigUses = getOrThrow(
    info.identifierUses,
    'readConfig',
    'readConfig identifier uses should be tracked',
  );
  assert.include(readConfigUses, 'path');
  assert.include(readConfigUses, 'fs');
});

test('Parse type-only imports correctly', () => {
  const src = `
import type { User } from './types';
import { format } from 'date-fns';

export function processUser(user: User): string {
  return format(new Date(), 'yyyy-MM-dd') + ': ' + user.name;
}
`;

  const info = parseIsolatedSourceCode(src);

  // Should distinguish type-only imports
  const expectedImports = [
    { moduleSpec: './types', names: ['User'], typeOnly: true },
    { moduleSpec: 'date-fns', names: ['format'], typeOnly: false },
  ];
  assert.deepEqual(info.imports, expectedImports);
});

test('Parse inline type specifiers correctly', () => {
  const src = `
import { type A, B } from 'mod';

export function foo(a: A): B {
  return B;
}
`;

  const info = parseIsolatedSourceCode(src);

  // Mixed import should be split: A is type-only, B is value
  const expectedImports = [
    { moduleSpec: 'mod', names: ['A'], typeOnly: true },
    { moduleSpec: 'mod', names: ['B'], typeOnly: false },
  ];
  assert.deepEqual(info.imports, expectedImports);

  // Verify per-specifier isTypeOnly in unresolvedExportsByImportNames
  const aExport = getOrThrow(
    info.unresolvedExportsByImportNames,
    'A',
    'A should be in unresolved exports',
  );
  assert.equal(aExport.isTypeOnly, true);
  const bExport = getOrThrow(
    info.unresolvedExportsByImportNames,
    'B',
    'B should be in unresolved exports',
  );
  assert.equal(bExport.isTypeOnly, false);

  // identifierUses should track both the type-only A (type annotation) and value B (return type + body)
  const fooUses = getOrThrow(
    info.identifierUses,
    'foo',
    'foo identifier uses should be tracked',
  );
  assert.include(fooUses, 'A');
  assert.include(fooUses, 'B');
});
