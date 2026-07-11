import { assert, describe, test } from 'vitest';
import { InMemoryFileSystem } from './filesystem';
import { inspectModule } from './inspectModule';
import { assertDefined } from './invariant';
import { parseIsolatedSourceCode } from './testUtils';

describe('detectAmbientNames over-approximation', () => {
  describe('includes truly ambient runtime references', () => {
    test('bare global reference is included', () => {
      const info = parseIsolatedSourceCode(`
const x = process.cwd();
`);
      assert.ok(info.ambientNames.has('process'));
    });

    test('unfamiliar global is included', () => {
      const info = parseIsolatedSourceCode(`
document.getElementById('foo');
`);
      assert.ok(info.ambientNames.has('document'));
    });

    test('fetch global is included', () => {
      const info = parseIsolatedSourceCode(`
fetch('/api/data');
`);
      assert.ok(info.ambientNames.has('fetch'));
    });

    test('setTimeout global is included', () => {
      const info = parseIsolatedSourceCode(`
setTimeout(() => {}, 1000);
`);
      assert.ok(info.ambientNames.has('setTimeout'));
    });

    test('multiple ambient references all included', () => {
      const info = parseIsolatedSourceCode(`
const a = process.cwd();
const b = document.title;
`);
      assert.ok(info.ambientNames.has('process'));
      assert.ok(info.ambientNames.has('document'));
    });
  });

  describe('excludes binding-name positions', () => {
    test('function parameter is excluded', () => {
      const info = parseIsolatedSourceCode(`
function foo(process) {
  console.log(process);
}
`);
      assert.ok(!info.ambientNames.has('process'));
    });

    test('local variable declaration is excluded', () => {
      const info = parseIsolatedSourceCode(`
const fetch = () => {};
fetch();
`);
      assert.ok(!info.ambientNames.has('fetch'));
    });

    test('function declaration name is excluded', () => {
      const info = parseIsolatedSourceCode(`
function process() {
  return 1;
}
process();
`);
      assert.ok(!info.ambientNames.has('process'));
    });

    test('class declaration name is excluded', () => {
      const info = parseIsolatedSourceCode(`
class Buffer {
  data = [];
}
new Buffer();
`);
      assert.ok(!info.ambientNames.has('Buffer'));
    });

    test('import binding is excluded', () => {
      const info = parseIsolatedSourceCode(`
import { process } from './mod';
process.foo();
`);
      assert.ok(!info.ambientNames.has('process'));
    });

    test('namespace import binding is excluded', () => {
      const info = parseIsolatedSourceCode(`
import * as Buffer from './buffer';
Buffer.alloc(10);
`);
      assert.ok(!info.ambientNames.has('Buffer'));
    });

    test('default import binding is excluded', () => {
      const info = parseIsolatedSourceCode(`
import document from './doc';
document.title = 'test';
`);
      assert.ok(!info.ambientNames.has('document'));
    });

    test('interface declaration name is excluded', () => {
      const info = parseIsolatedSourceCode(`
interface Foo {
  bar: string;
}
const x: Foo = { bar: 'a' };
`);
      assert.ok(!info.ambientNames.has('Foo'));
    });

    test('type alias name is excluded', () => {
      const info = parseIsolatedSourceCode(`
type Buffer = Uint8Array;
const b: Buffer = new Uint8Array();
`);
      assert.ok(!info.ambientNames.has('Buffer'));
    });

    test('enum declaration name is excluded', () => {
      const info = parseIsolatedSourceCode(`
enum Status { Active }
const s = Status.Active;
`);
      assert.ok(!info.ambientNames.has('Status'));
    });

    test('catch clause variable is excluded', () => {
      const info = parseIsolatedSourceCode(`
try {} catch (error) {
  console.log(error);
}
`);
      assert.ok(!info.ambientNames.has('error'));
    });

    test('for-of loop variable is excluded', () => {
      const info = parseIsolatedSourceCode(`
for (const item of items) {
  console.log(item);
}
`);
      assert.ok(!info.ambientNames.has('item'));
      assert.ok(info.ambientNames.has('items'));
    });

    test('destructuring bindings are excluded', () => {
      const info = parseIsolatedSourceCode(`
const { process, fetch } = config;
console.log(process, fetch);
`);
      assert.ok(!info.ambientNames.has('process'));
      assert.ok(!info.ambientNames.has('fetch'));
      assert.ok(info.ambientNames.has('config'));
    });
  });

  describe('excludes property-name positions', () => {
    test('property access is excluded', () => {
      const info = parseIsolatedSourceCode(`
const x = obj.process;
`);
      assert.ok(!info.ambientNames.has('process'));
      assert.ok(info.ambientNames.has('obj'));
    });

    test('property signature in interface is excluded', () => {
      const info = parseIsolatedSourceCode(`
interface Config {
  process: string;
}
`);
      assert.ok(!info.ambientNames.has('process'));
    });

    test('property assignment in object literal is excluded', () => {
      const info = parseIsolatedSourceCode(`
const x = { process: 'value' };
`);
      assert.ok(!info.ambientNames.has('process'));
    });

    test('class property declaration is excluded', () => {
      const info = parseIsolatedSourceCode(`
class Foo {
  process: string;
}
`);
      assert.ok(!info.ambientNames.has('process'));
    });
  });

  describe('excludes type-only contexts', () => {
    test('type annotation is excluded', () => {
      const info = parseIsolatedSourceCode(`
const x: Buffer = new ArrayBuffer();
`);
      assert.ok(!info.ambientNames.has('Buffer'));
    });

    test('generic type argument is excluded', () => {
      const info = parseIsolatedSourceCode(`
const x: Promise<Buffer> = Promise.resolve();
`);
      assert.ok(!info.ambientNames.has('Buffer'));
      assert.ok(info.ambientNames.has('Promise'));
    });

    test('typeof operand is a runtime reference, not type-only', () => {
      const info = parseIsolatedSourceCode(`
const x: typeof process = globalThis;
`);
      assert.ok(info.ambientNames.has('process'));
      assert.ok(info.ambientNames.has('globalThis'));
    });

    test('type-only import binding does not create ambient reference', () => {
      const info = parseIsolatedSourceCode(`
import type { Buffer } from 'buffer';
const x: Buffer = new ArrayBuffer();
`);
      assert.ok(!info.ambientNames.has('Buffer'));
    });
  });

  describe('typeof guard blocks', () => {
    test('runtime reference inside typeof guard block is included', () => {
      const info = parseIsolatedSourceCode(`
if (typeof process !== 'undefined') {
  const x = process.cwd();
}
`);
      assert.ok(info.ambientNames.has('process'));
    });
  });

  describe('leaked locals are permitted (over-approximation)', () => {
    test('unbound reference inside function body is included', () => {
      const info = parseIsolatedSourceCode(`
function handler() {
  const data = getData();
  return data;
}
`);
      assert.ok(info.ambientNames.has('getData'));
    });
  });

  describe('inspectModule populates ambientNames', () => {
    test('ambientNames is populated in ModuleInfo', async () => {
      const files = new Map<string, string>([
        ['/repo/tsconfig.json', JSON.stringify({ compilerOptions: {} })],
        ['/repo/src/file.ts', 'const x = process.cwd();\n'],
      ]);
      const fileSystem = new InMemoryFileSystem(files);

      const moduleInfo = await inspectModule(
        '/repo',
        '/repo/src/file.ts',
        fileSystem,
      );
      assertDefined(moduleInfo, 'Module info should be returned');
      assert.ok(moduleInfo.ambientNames.includes('process'));
    });
  });
});
