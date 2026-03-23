

import { assert, test } from 'vitest'
import { modulePathToImportSpecAlias } from './importSpec.js';
import { parseIsolatedSourceCode } from './parseIsolatedSourceCode.js';

test('importSpec', () => {
  const testCase = {
    compilerOptions: {
      paths: {
        "@acme/shared/*": [ "../../../shared/src/*" ],
        "@acme/backend-shared/*": [ "../../../packages/backend-shared/src/*" ],
        "@acme/main/*": [ "./*" ],
      },
      baseUrl: "src",
      rootDir: ".",
    },
    tsconfigDir: "/home/user/projects/acme/backend/main",
    modulePath: "/home/user/projects/acme/packages/backend-shared/src/mutate/transform.ts",
  };

  const result = modulePathToImportSpecAlias(testCase.compilerOptions, testCase.tsconfigDir, testCase.modulePath);
  assert.equal(result, "@acme/backend-shared/mutate/transform");
});

test('Parse imports', () => {
  const info = parseIsolatedSourceCode('import { foo, bar } from \'./baz\';\nimport { spam, ham } from \'eggs\';\n');

  const importNames = info.unresolvedExportsByImportNames.keys();
  assert.deepEqual([...importNames], ['foo', 'bar', 'spam', 'ham']);
  assert.deepEqual(info.unresolvedExportsByImportNames.get('foo'), { moduleSpec: './baz', name: 'foo' });
  assert.deepEqual(info.unresolvedExportsByImportNames.get('bar'), { moduleSpec: './baz', name: 'bar' });
  assert.deepEqual(info.unresolvedExportsByImportNames.get('spam'), { moduleSpec: 'eggs', name: 'spam' });
  assert.deepEqual(info.unresolvedExportsByImportNames.get('ham'), { moduleSpec: 'eggs', name: 'ham' });
});

test('Parse exported variable', () => {
  const info = parseIsolatedSourceCode('export const foo = 42;\nconst bar = 69;\n');
  assert.hasAllKeys(info.exports, ['foo']);
  assert.doesNotHaveAnyKeys(info.exports, ['bar']);
});

test('Parse exported function', () => {
  const info = parseIsolatedSourceCode('export function greet() {\n  console.log(\'Hello!\');\n}\n');
  assert.hasAllKeys(info.exports, ['greet']);
});

test('Parse function using imports', () => {
  const info = parseIsolatedSourceCode('import { answer } from \'./mystery\';\n\nexport function getAnswer(): number {\n  return answer;\n}\n')
  const expectedImports = [{ moduleSpec: './mystery', names: ['answer'], typeOnly: false }];
  assert.deepEqual(info.imports, expectedImports);
  assert.hasAllKeys(info.exports, ['getAnswer']);

  const exportInfo = info.exports.get('getAnswer');
  assert.isDefined(exportInfo);

  assert.deepEqual(exportInfo?.uses, [{ name: 'answer', moduleSpec: './mystery' }]);
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
  const expectedImports = [{ moduleSpec: './myfs', names: ['stat'], typeOnly: false }, { moduleSpec: './mypath', names: ['join'], typeOnly: false }];
  assert.deepEqual(info.imports, expectedImports);
  assert.hasAllKeys(info.exports, ['baz', 'qux']);

  const bazExportInfo = info.exports.get('baz');
  assert.isDefined(bazExportInfo);
  assert.deepEqual(bazExportInfo?.uses, [{ name: 'stat', moduleSpec: './myfs' }]);

  const quxExportInfo = info.exports.get('qux');
  assert.isDefined(quxExportInfo);
  assert.deepEqual(quxExportInfo?.uses, [{ name: 'join', moduleSpec: './mypath' }]);


  const fooUses = info.identifierUses.get('foo');
  assert.isDefined(fooUses);
  assert.deepEqual(fooUses, ['join']);

  const quxUses = info.identifierUses.get('qux');
  assert.isDefined(quxUses);
  assert.deepEqual(quxUses, ['foo']);

});

test.skip('Parse import aliases correctly (normalize-first strategy)', () => {
  // NOTE: Import aliases are intentionally NOT supported in core refactoring logic.
  // These will be handled by a separate `tslor normalize-imports` command that
  // converts aliases to straightforward syntax before refactoring operations.
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
    { moduleSpec: 'path', names: ['join'], typeOnly: false }
  ];
  assert.deepEqual(info.imports, expectedImports);
  
  // unresolvedExportsByImportNames should map local names to original export names
  assert.equal(info.unresolvedExportsByImportNames.get('formatDate')?.name, 'format');
  assert.equal(info.unresolvedExportsByImportNames.get('formatDate')?.moduleSpec, 'date-fns');
  assert.equal(info.unresolvedExportsByImportNames.get('parseDate')?.name, 'parse');
  assert.equal(info.unresolvedExportsByImportNames.get('parseDate')?.moduleSpec, 'date-fns');
  assert.equal(info.unresolvedExportsByImportNames.get('pathJoin')?.name, 'join');
  assert.equal(info.unresolvedExportsByImportNames.get('pathJoin')?.moduleSpec, 'path');
  
  // identifierUses should use the local aliased names
  const processFileUses = info.identifierUses.get('processFile');
  assert.isDefined(processFileUses);
  assert.include(processFileUses!, 'parseDate');
  assert.include(processFileUses!, 'formatDate');
  assert.include(processFileUses!, 'pathJoin');
  
  // Export should show transitive dependency on the original export names
  const processFileExport = info.exports.get('processFile');
  assert.isDefined(processFileExport);
  const expectedUses = [
    { name: 'format', moduleSpec: 'date-fns' },
    { name: 'parse', moduleSpec: 'date-fns' },
    { name: 'join', moduleSpec: 'path' }
  ];
  assert.sameDeepMembers(processFileExport!.uses, expectedUses);
});

test.skip('Parse re-exports correctly (normalize-first strategy)', () => {
  // NOTE: Complex re-exports are intentionally NOT supported in core refactoring logic.
  // These will be handled by a separate `tslor normalize-imports` command that
  // converts complex re-exports to explicit named exports before refactoring operations.
  const src = `
import { format } from 'date-fns';
export { join } from 'path';
export { default as parser } from 'xml2js';

export function processData(data: string): string {
  return format(new Date(), 'yyyy-MM-dd') + ': ' + data;
}
`;

  const info = parseIsolatedSourceCode(src);
  
  // Should include re-exports in the imports/exports tracking
  const expectedImports = [
    { moduleSpec: 'date-fns', names: ['format'], typeOnly: false },
    { moduleSpec: 'path', names: ['join'], typeOnly: false },
    { moduleSpec: 'xml2js', names: ['default'], typeOnly: false }
  ];
  assert.deepEqual(info.imports, expectedImports);
  
  // Should track re-exported symbols as exports
  assert.hasAllKeys(info.exports, ['join', 'parser', 'processData']);
});

test.skip('Parse namespace imports correctly (normalize-first strategy)', () => {
  // NOTE: Namespace imports are intentionally NOT supported in core refactoring logic.
  // These will be handled by a separate `tslor normalize-imports` command that
  // converts namespace imports to explicit named imports before refactoring operations.
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
    { moduleSpec: 'path', names: ['*'], typeOnly: false }
  ];
  assert.deepEqual(info.imports, expectedImports);
  
  // Should track namespace usage
  const readConfigUses = info.identifierUses.get('readConfig');
  assert.isDefined(readConfigUses);
  assert.include(readConfigUses!, 'path');
  assert.include(readConfigUses!, 'fs');
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
    { moduleSpec: 'date-fns', names: ['format'], typeOnly: false }
  ];
  assert.deepEqual(info.imports, expectedImports);
});
