import { assert, describe, test } from 'vitest';
import { filterTrulyAmbientNames, getModuleBindingSet } from './sealedBinder';

function assertBindingSet(source: string, expected: readonly string[]): void {
  const actual = getModuleBindingSet(source, {});
  assert.deepStrictEqual([...actual].sort(), [...expected].sort());
}

describe('getModuleBindingSet', () => {
  describe('import forms', () => {
    test('includes default import', () => {
      assertBindingSet(
        `import defaultExport from 'module';`,
        ['defaultExport'],
      );
    });

    test('includes named imports', () => {
      assertBindingSet(
        `import { named1, named2 } from 'module';`,
        ['named1', 'named2'],
      );
    });

    test('includes aliased named imports', () => {
      assertBindingSet(
        `import { original as alias } from 'module';`,
        ['alias'],
      );
    });

    test('includes namespace import', () => {
      assertBindingSet(
        `import * as ns from 'module';`,
        ['ns'],
      );
    });

    test('includes import = require()', () => {
      assertBindingSet(
        `import mod = require('module');`,
        ['mod'],
      );
    });
  });

  describe('destructuring', () => {
    test('includes nested destructuring names', () => {
      assertBindingSet(
        `const { a, b: { c, d: renamed } } = obj;`,
        ['a', 'c', 'renamed'],
      );
    });

    test('includes array destructuring names', () => {
      assertBindingSet(
        `const [first, , third] = arr;`,
        ['first', 'third'],
      );
    });

    test('includes rest destructuring names', () => {
      assertBindingSet(
        `const { a, ...rest } = obj;`,
        ['a', 'rest'],
      );
    });

    test('includes nested array destructuring with rest', () => {
      assertBindingSet(
        `const [head, ...tail] = arr;`,
        ['head', 'tail'],
      );
    });
  });

  describe('var hoisting from top-level blocks', () => {
    test('includes var hoisted from a top-level block', () => {
      assertBindingSet(
        `if (true) { var hoisted = 1; }`,
        ['hoisted'],
      );
    });

    test('includes var hoisted from nested blocks inside a top-level statement', () => {
      assertBindingSet(
        `if (true) { if (true) { var deepHoisted = 1; } }`,
        ['deepHoisted'],
      );
    });

    test('includes var hoisted from a top-level for loop', () => {
      assertBindingSet(
        `for (var i = 0; i < 10; i++) {}`,
        ['i'],
      );
    });

    test('includes var hoisted from a top-level while loop', () => {
      assertBindingSet(
        `while (true) { var x = 1; break; }`,
        ['x'],
      );
    });
  });

  describe('declaration kinds', () => {
    test('includes function declarations', () => {
      assertBindingSet(
        `function myFunc() {}`,
        ['myFunc'],
      );
    });

    test('includes class declarations', () => {
      assertBindingSet(
        `class MyClass {}`,
        ['MyClass'],
      );
    });

    test('includes interface declarations', () => {
      assertBindingSet(
        `interface MyInterface {}`,
        ['MyInterface'],
      );
    });

    test('includes type alias declarations', () => {
      assertBindingSet(
        `type MyType = string;`,
        ['MyType'],
      );
    });

    test('includes enum declarations', () => {
      assertBindingSet(
        `enum MyEnum { A, B }`,
        ['MyEnum'],
      );
    });

    test('includes namespace declarations', () => {
      assertBindingSet(
        `namespace MyNamespace { export const x = 1; }`,
        ['MyNamespace'],
      );
    });

    test('includes variable statements (const, let, var)', () => {
      assertBindingSet(
        `const a = 1; let b = 2; var c = 3;`,
        ['a', 'b', 'c'],
      );
    });

    test('includes multiple declarations in one variable statement', () => {
      assertBindingSet(
        `const a = 1, b = 2, c = 3;`,
        ['a', 'b', 'c'],
      );
    });

    test('excludes namespace members', () => {
      assertBindingSet(
        `namespace NS { export const x = 1; function y() {} }`,
        ['NS'],
      );
    });
  });

  describe('exclusion of inner-scope bindings', () => {
    test('excludes function parameters', () => {
      assertBindingSet(
        `function fn(param1, param2: string) { return param1 + param2; }`,
        ['fn'],
      );
    });

    test('excludes function-local variables', () => {
      assertBindingSet(
        `function fn() { const local = 1; let alsoLocal = 2; }`,
        ['fn'],
      );
    });

    test('excludes var inside a function body', () => {
      assertBindingSet(
        `function fn() { var fnLocal = 1; }`,
        ['fn'],
      );
    });

    test('excludes arrow function parameters', () => {
      assertBindingSet(
        `const fn = (arg) => arg;`,
        ['fn'],
      );
    });

    test('excludes arrow function locals', () => {
      assertBindingSet(
        `const fn = () => { const inner = 1; return inner; };`,
        ['fn'],
      );
    });

    test('excludes class method parameters', () => {
      assertBindingSet(
        `class C { method(param) { return param; } }`,
        ['C'],
      );
    });

    test('excludes class property declarations', () => {
      assertBindingSet(
        `class C { prop: string = 'value'; }`,
        ['C'],
      );
    });

    test('excludes class method declarations', () => {
      assertBindingSet(
        `class C { method() {} }`,
        ['C'],
      );
    });

    test('excludes class constructor parameters', () => {
      assertBindingSet(
        `class C { constructor(dep) {} }`,
        ['C'],
      );
    });

    test('excludes catch clause variable', () => {
      assertBindingSet(
        `function fn() { try {} catch (e) { throw e; } }`,
        ['fn'],
      );
    });

    test('excludes for-loop let declarations', () => {
      assertBindingSet(
        `for (let i = 0; i < 10; i++) {}`,
        [],
      );
    });

    test('distinguishes module-level var from function-level var', () => {
      assertBindingSet(
        `var moduleVar = 1; function fn() { var fnVar = 2; }`,
        ['moduleVar', 'fn'],
      );
    });
  });

  describe('edge cases', () => {
    test('handles empty source', () => {
      assertBindingSet('', []);
    });

    test('handles source with only comments', () => {
      assertBindingSet('// just a comment\n/* another */', []);
    });

    test('handles type-only imports', () => {
      assertBindingSet(
        `import type { SomeType } from 'mod';`,
        ['SomeType'],
      );
    });

    test('handles side-effect imports (no binding)', () => {
      assertBindingSet(
        `import 'polyfill';`,
        [],
      );
    });
  });
});

describe('filterTrulyAmbientNames', () => {
  test('removes function-local names from candidates', () => {
    const source = `
function handler() {
  const data = getData();
  return data;
}
`;
    const result = filterTrulyAmbientNames(source, ['data'], {});
    assert.strictEqual(result.size, 0);
  });

  test('retains unbound ambient references', () => {
    const source = `
const x = process.cwd();
`;
    const result = filterTrulyAmbientNames(source, ['process'], {});
    assert.ok(result.has('process'));
  });
});

