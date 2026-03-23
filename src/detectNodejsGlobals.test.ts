import { describe, test, expect } from 'vitest';
import { parseIsolatedSourceCode } from './parseIsolatedSourceCode';

describe('Node.js global detection', () => {
  test('detects actual Buffer usage (not guarded)', () => {
    const result = parseIsolatedSourceCode(`
      export function decodeBase64(data: string): Uint8Array {
        return Buffer.from(data, 'base64');
      }
    `);
    expect(result.usesNodejsGlobals).toBe(true);
    expect(result.nodejsGlobalUsages).toHaveLength(1);
    expect(result.nodejsGlobalUsages?.[0].identifier).toBe('Buffer');
  });

  test('ignores Buffer in type position', () => {
    const result = parseIsolatedSourceCode(`
      export function readFile(): Promise<Buffer> {
        return Promise.resolve(new Uint8Array());
      }
    `);
    expect(result.usesNodejsGlobals).toBe(false);
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
    expect(result.usesNodejsGlobals).toBe(false);
  });

  test('ignores process in typeof type query', () => {
    const result = parseIsolatedSourceCode(`
      export interface NodeApi {
        process: typeof process;
      }
    `);
    expect(result.usesNodejsGlobals).toBe(false);
  });

  test('ignores process as property name in interface', () => {
    const result = parseIsolatedSourceCode(`
      export interface ServiceLinks {
        process: string;
        processorRequest: string;
      }
    `);
    expect(result.usesNodejsGlobals).toBe(false);
  });

  test('ignores process as method name in interface', () => {
    const result = parseIsolatedSourceCode(`
      export interface ShaderContext {
        process(data: any): Promise<void>;
      }
    `);
    expect(result.usesNodejsGlobals).toBe(false);
  });

  test('ignores process as method name in class', () => {
    const result = parseIsolatedSourceCode(`
      export class Processor {
        process(data: any): void {
          console.log(data);
        }
      }
    `);
    expect(result.usesNodejsGlobals).toBe(false);
  });

  test('parameter name shadows global (known limitation)', () => {
    // This is a known limitation - we detect the parameter binding but
    // references to it via 'this.require' are still flagged as potential globals
    const result = parseIsolatedSourceCode(`
      export class LazyRequire {
        constructor(public require: (id: string) => any) {}
        load(module: string) {
          return this.require(module);
        }
      }
    `);
    // Currently detects this.require as a global (false positive)
    // Full scope analysis would be needed to fix this edge case
    expect(result.usesNodejsGlobals).toBe(true);
  });

  test('ignores global in property access', () => {
    const result = parseIsolatedSourceCode(`
      if (typeof window !== 'undefined') {
        (window as any).global = window;
      }
    `);
    expect(result.usesNodejsGlobals).toBe(false);
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
    expect(result.usesNodejsGlobals).toBe(false);
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
    expect(result.usesNodejsGlobals).toBe(false);
  });

  test('detects unguarded process.env usage', () => {
    const result = parseIsolatedSourceCode(`
      export const apiUrl = process.env.API_URL || 'http://localhost';
    `);
    expect(result.usesNodejsGlobals).toBe(true);
    expect(result.nodejsGlobalUsages?.[0].identifier).toBe('process');
  });

  test('ignores __dirname in type annotation', () => {
    const result = parseIsolatedSourceCode(`
      export type DirName = typeof __dirname;
    `);
    expect(result.usesNodejsGlobals).toBe(false);
  });

  test('detects multiple Node.js globals', () => {
    const result = parseIsolatedSourceCode(`
      export function encodeData(data: string): Buffer {
        const buf = Buffer.from(data);
        return require('zlib').gzipSync(buf);
      }
    `);
    expect(result.usesNodejsGlobals).toBe(true);
    expect(result.nodejsGlobalUsages).toHaveLength(2);
    const identifiers = result.nodejsGlobalUsages?.map(u => u.identifier) || [];
    expect(identifiers).toContain('Buffer');
    expect(identifiers).toContain('require');
  });

  test('variable name shadows global (known limitation)', () => {
    // This is a known limitation - we detect the variable declaration but
    // references to it are still flagged as potential globals
    const result = parseIsolatedSourceCode(`
      export function startProcess() {
        const process = { id: 1, name: 'test' };
        return process.id;
      }
    `);
    // Currently detects process.id as a global (false positive)
    // Full scope analysis would be needed to fix this edge case
    expect(result.usesNodejsGlobals).toBe(true);
  });

  test('ignores exports as property in object literal', () => {
    const result = parseIsolatedSourceCode(`
      export const config = {
        exports: ['foo', 'bar'],
        imports: ['baz']
      };
    `);
    expect(result.usesNodejsGlobals).toBe(false);
  });
});