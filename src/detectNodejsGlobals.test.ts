import { assert, describe, test } from 'vitest';
import { parseIsolatedSourceCode } from './parseIsolatedSourceCode';

describe('Node.js global detection', () => {
  test('detects actual Buffer usage (not guarded)', () => {
    const result = parseIsolatedSourceCode(`
      export function decodeBase64(data: string): Uint8Array {
        return Buffer.from(data, 'base64');
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, true);
    assert.strictEqual(result.nodejsGlobalUsages?.length, 1);
    assert.strictEqual(result.nodejsGlobalUsages?.[0]?.identifier, 'Buffer');
  });

  test('ignores Buffer in type position', () => {
    const result = parseIsolatedSourceCode(`
      export function readFile(): Promise<Buffer> {
        return Promise.resolve(new Uint8Array());
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('ignores process in typeof guard', () => {
    const result = parseIsolatedSourceCode(`
      let env: Record<string, string | undefined>;
      if (typeof process !== 'undefined') {
        env = process.env;
      } else {
        env = {};
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('ignores process in typeof type query', () => {
    const result = parseIsolatedSourceCode(`
      export interface NodeApi {
        process: typeof process;
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('ignores process as property name in interface', () => {
    const result = parseIsolatedSourceCode(`
      export interface ServiceLinks {
        process: string;
        processorRequest: string;
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('ignores process as method name in interface', () => {
    const result = parseIsolatedSourceCode(`
      export interface ShaderContext {
        process(data: any): Promise<void>;
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('ignores process as method name in class', () => {
    const result = parseIsolatedSourceCode(`
      export class Processor {
        process(data: any): void {
          console.log(data);
        }
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('parameter name shadows global (known limitation)', () => {
    /*
      This is a known limitation - we detect the parameter binding but
      references to it via 'this.require' are still flagged as potential globals.
      Full scope analysis would be needed to fix this edge case.
    */
    const result = parseIsolatedSourceCode(`
      export class LazyRequire {
        constructor(public require: (id: string) => any) {}
        load(module: string) {
          return this.require(module);
        }
      }
    `);
    // Currently detects this.require as a global (false positive)
    assert.strictEqual(result.usesNodejsGlobals, true);
  });

  test('ignores global in property access', () => {
    const result = parseIsolatedSourceCode(`
      if (typeof window !== 'undefined') {
        (window as any).global = window;
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('ignores global in declare global', () => {
    const result = parseIsolatedSourceCode(`
      declare global {
        interface HTMLMediaElement {
          controlsList: DOMTokenList;
        }
      }
      export {};
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('ignores Buffer as type reference', () => {
    const result = parseIsolatedSourceCode(`
      export const readFileAsync = (
        filePath: string,
        encoding?: string
      ): Promise<Buffer | string | undefined> => {
        return Promise.resolve(undefined);
      };
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('detects unguarded process.env usage', () => {
    const result = parseIsolatedSourceCode(`
      export const apiUrl = process.env.API_URL || 'http://localhost';
    `);
    assert.strictEqual(result.usesNodejsGlobals, true);
    assert.strictEqual(result.nodejsGlobalUsages?.[0]?.identifier, 'process');
  });

  test('ignores __dirname in type annotation', () => {
    const result = parseIsolatedSourceCode(`
      export type DirName = typeof __dirname;
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });

  test('detects multiple Node.js globals', () => {
    const result = parseIsolatedSourceCode(`
      export function encodeData(data: string): Buffer {
        const buf = Buffer.from(data);
        return require('zlib').gzipSync(buf);
      }
    `);
    assert.strictEqual(result.usesNodejsGlobals, true);
    assert.strictEqual(result.nodejsGlobalUsages?.length, 2);
    const identifiers = result.nodejsGlobalUsages?.map(u => u.identifier) || [];
    assert.include(identifiers, 'Buffer');
    assert.include(identifiers, 'require');
  });

  test('variable name shadows global (known limitation)', () => {
    /*
      This is a known limitation - we detect the variable declaration but
      references to it are still flagged as potential globals.
      Full scope analysis would be needed to fix this edge case.
    */
    const result = parseIsolatedSourceCode(`
      export function startProcess() {
        const process = { id: 1, name: 'test' };
        return process.id;
      }
    `);
    // Currently detects process.id as a global (false positive)
    assert.strictEqual(result.usesNodejsGlobals, true);
  });

  test('ignores exports as property in object literal', () => {
    const result = parseIsolatedSourceCode(`
      export const config = {
        exports: ['foo', 'bar'],
        imports: ['baz']
      };
    `);
    assert.strictEqual(result.usesNodejsGlobals, false);
  });
});
