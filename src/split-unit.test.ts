import { assert, describe, test } from 'vitest';
import { Project } from 'ts-morph';
import { parseModule, analyzeImportUsageFromStaticInfo } from './staticAnalysis';
import { assertDefined, getOrThrow } from './invariant';
import {
  buildIntraModuleDependencies,
  detectCircularDependencies,
  analyzeSplit,
  extractSymbolDefinitions,
  findImportsOnlyUsedBySymbols,
  findSharedNonExportedDeps,
  computeRequiredImports,
  generateNewModuleSource,
  removeSymbolsFromSource,
  removeUnusedImports,
  addImportForMovedSymbols,
  type IntraModuleDependencies,
} from './splitModule';
import { createTestSourceFile } from './testUtils';

const TYPEOF_CONST_FIXTURE = `
import type { ExternalType } from './external';

export const myConstArray = <const>['value1', 'value2'];

export type DerivedFromConst = typeof myConstArray[number];

export interface UsesImportedType {
  field: ExternalType;
}

export type MappedTypeUsingImport = {
  [K in ExternalType]: string | null;
};

export interface Item {
  pendingRequest?: DerivedFromConst;
  data?: UsesImportedType;
  mapped?: MappedTypeUsingImport;
}
`;

function collectAllRequiredDeps(
  deps: IntraModuleDependencies,
  symbols: Iterable<string>,
): Set<string> {
  const allRequired = new Set<string>();
  for (const symbol of symbols) {
    allRequired.add(symbol);
    const analysis = analyzeSplit(deps, symbol);
    for (const req of analysis.requiredDependencies) {
      allRequired.add(req);
    }
  }
  return allRequired;
}

describe('buildIntraModuleDependencies', () => {
  test('identifies simple internal dependencies', () => {
    const source = `
export function formatDate(date: Date): string {
  return formatISODate(date);
}

function formatISODate(date: Date): string {
  return date.toISOString();
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    assert.ok(moduleInfo.exportedNames.has('formatDate'));
    assert.ok(moduleInfo.exportedNames.has('validateEmail'));

    const deps = buildIntraModuleDependencies(moduleInfo, source);
    const formatDateDeps = getOrThrow(
      deps.dependencies,
      'formatDate',
      'formatDateDeps should be defined',
    );
    assert.isTrue(formatDateDeps.has('formatISODate'));

    const validateEmailDeps = getOrThrow(
      deps.dependencies,
      'validateEmail',
      'validateEmailDeps should be defined',
    );
    assert.equal(validateEmailDeps.size, 0);
  });

  test('tracks transitive dependencies', () => {
    const source = `
export function processData(data: string): string {
  const validated = validateInput(data);
  return formatOutput(validated);
}

function validateInput(input: string): string {
  return sanitizeInput(input);
}

function sanitizeInput(input: string): string {
  return input.trim();
}

function formatOutput(data: string): string {
  return data.toUpperCase();
}

export function otherFunction(): void {}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);
    const splitAnalysis = analyzeSplit(deps, 'processData');

    assert.isTrue(splitAnalysis.canSplit);
    const expectedDeps = new Set([
      'validateInput',
      'sanitizeInput',
      'formatOutput',
    ]);
    assert.deepEqual(splitAnalysis.requiredDependencies, expectedDeps);
  });

  test('detects circular dependencies', () => {
    const source = `
export function funcA(): string {
  return funcB() + 'A';
}

function funcB(): string {
  return funcC() + 'B';
}

function funcC(): string {
  return funcA() + 'C';
}

export function independent(): string {
  return 'standalone';
}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);
    const cycles = detectCircularDependencies(deps);

    assert.isTrue(cycles.length > 0);

    /*
      funcA's cycle (A->B->C->A) is self-contained: all three move together.
      This is allowed — the cycle just moves into the new module.
      requiredDependencies are symbols that move WITH the target, not the target itself.
    */
    const splitAnalysis = analyzeSplit(deps, 'funcA');
    assert.isTrue(splitAnalysis.canSplit);
    assert.equal(splitAnalysis.circularDependencies.length, 0);
    assert.deepEqual(splitAnalysis.requiredDependencies, new Set(['funcB', 'funcC']));

    // independent is not part of any cycle and has no dependencies
    const splitAnalysisB = analyzeSplit(deps, 'independent');
    assert.isTrue(splitAnalysisB.canSplit);
    assert.equal(splitAnalysisB.requiredDependencies.size, 0);
  });

  test('allows moving symbols with disjoint cycles', () => {
    const source = `
export function funcA(): string {
  return funcB() + 'A';
}

function funcB(): string {
  return funcA() + 'B';
}

export function funcC(): string {
  return funcD() + 'C';
}

function funcD(): string {
  return funcE() + 'D';
}

function funcE(): string {
  return funcD() + 'E';
}
`;
    /*
      Two disjoint cycles:
      - funcA <-> funcB
      - funcD <-> funcE

      Moving funcC pulls in funcD and funcE (their cycle moves with it).
      funcA/funcB cycle is untouched — it stays behind.
      No cross-boundary issue because the target's transitive deps
      form a self-contained set (if any cycle member is a transitive
      dep, all members are, since cycles are strongly connected).
    */
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);
    const cycles = detectCircularDependencies(deps);
    assert.equal(cycles.length, 2);

    const splitAnalysis = analyzeSplit(deps, 'funcC');
    assert.isTrue(splitAnalysis.canSplit);
    assert.deepEqual(splitAnalysis.requiredDependencies, new Set(['funcD', 'funcE']));
  });

  test('handles shared dependencies across exports', () => {
    const source = `
export function formatUser(user: unknown): string {
  return formatName(user.name) + ' (' + formatEmail(user.email) + ')';
}

export function displayUser(user: unknown): string {
  return 'User: ' + formatName(user.name);
}

function formatName(name: string): string {
  return capitalize(name);
}

function formatEmail(email: string): string {
  return email.toLowerCase();
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);

    const formatUserSplit = analyzeSplit(deps, 'formatUser');
    assert.isTrue(formatUserSplit.canSplit);
    const expectedDeps = new Set(['formatName', 'formatEmail', 'capitalize']);
    assert.deepEqual(formatUserSplit.requiredDependencies, expectedDeps);

    const displayUserSplit = analyzeSplit(deps, 'displayUser');
    assert.isTrue(displayUserSplit.canSplit);
    const expectedDisplayDeps = new Set(['formatName', 'capitalize']);
    assert.deepEqual(
      displayUserSplit.requiredDependencies,
      expectedDisplayDeps,
    );
  });

  test('excludes built-in methods from definitions', () => {
    const source = `
export function processData(input: string): string {
  const validated = validateInput(input);
  return formatOutput(validated);
}

function validateInput(data: string): string {
  return sanitizeInput(data);
}

function sanitizeInput(input: string): string {
  return input.trim();
}

function formatOutput(data: string): string {
  return data.toUpperCase();
}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);

    assert.isFalse(deps.definitions.has('trim'));
    assert.isFalse(deps.definitions.has('toUpperCase'));
    assert.isTrue(deps.definitions.has('processData'));
    assert.isTrue(deps.definitions.has('validateInput'));
    assert.isTrue(deps.definitions.has('sanitizeInput'));
    assert.isTrue(deps.definitions.has('formatOutput'));
  });

  test('handles typeof dependencies on const values', () => {
    const moduleInfo = parseModule(createTestSourceFile(TYPEOF_CONST_FIXTURE));
    const deps = buildIntraModuleDependencies(moduleInfo, TYPEOF_CONST_FIXTURE);

    const derivedDeps = getOrThrow(
      deps.dependencies,
      'DerivedFromConst',
      'derivedDeps should be defined',
    );
    assert.isTrue(
      derivedDeps.has('myConstArray'),
      'DerivedFromConst should depend on myConstArray (typeof dependency)',
    );
  });

  test('detects mapped type dependencies on key and value types', () => {
    const source = `
import type { ExternalDep1, ExternalDep2, ExternalSlot } from './external';

export interface LocalIcon {
  icon: string;
  tooltip?: string;
}

export type IconMap = {
  [K in ExternalSlot]: LocalIcon | null;
};

export interface Request {
  executedBy: string;
  params: ExternalDep1;
}

export interface Entry {
  value: ExternalDep2;
}

export interface Data {
  id: string;
  name: string;
}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);

    const symbolsToMove = new Set(['IconMap', 'Request', 'Entry']);
    const allRequired = collectAllRequiredDeps(deps, symbolsToMove);

    assert.isTrue(
      allRequired.has('LocalIcon'),
      'LocalIcon should be required because IconMap references it in the mapped type value',
    );
  });

  test('detects transitive type reference dependencies', () => {
    const source = `
export type ItemCustomIconsDto = Record<string, string>;

export interface ItemCustomIconBlendedDto {
  iconUrl: string;
}

export type ItemCustomIconUpdateDto = {
  customIcons: ItemCustomIconsDto
};

export type ItemCustomIconsBlendedDto = (ItemCustomIconBlendedDto | null)[];
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);

    const updateDtoDeps = getOrThrow(
      deps.dependencies,
      'ItemCustomIconUpdateDto',
      'updateDtoDeps should be defined',
    );
    assert.isTrue(updateDtoDeps.has('ItemCustomIconsDto'));

    const blendedDtoDeps = getOrThrow(
      deps.dependencies,
      'ItemCustomIconsBlendedDto',
      'blendedDtoDeps should be defined',
    );
    assert.isTrue(blendedDtoDeps.has('ItemCustomIconBlendedDto'));

    const symbolsToMove = new Set([
      'ItemCustomIconUpdateDto',
      'ItemCustomIconsBlendedDto',
    ]);
    const allRequired = collectAllRequiredDeps(deps, symbolsToMove);

    assert.isTrue(allRequired.has('ItemCustomIconsDto'));
    assert.isTrue(allRequired.has('ItemCustomIconBlendedDto'));
  });

  test('type property references are detected as dependencies', () => {
    const source = `
export interface DerivedClip {
  type: "derived";
}

export interface VirtualClip extends DerivedClip {
  masterClipId: string;
  inPoint: number;
  outPoint: number;
}

export interface Item {
  id: string;
  virtualClipInfo?: VirtualClip;
}

export interface PendingArchiveRequest {
  itemId: string;
}

export interface PendingTransferRequest {
  itemId: string;
}

export interface OtherType {
  value: string;
}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);

    const requestedSymbols = [
      'Item',
      'PendingArchiveRequest',
      'PendingTransferRequest',
    ];
    const allSymbolsToMove = collectAllRequiredDeps(deps, requestedSymbols);

    assert.isTrue(allSymbolsToMove.has('VirtualClip'));
    assert.isTrue(allSymbolsToMove.has('DerivedClip'));
    assert.isFalse(allSymbolsToMove.has('OtherType'));

    const expectedSymbols = new Set([
      'Item',
      'PendingArchiveRequest',
      'PendingTransferRequest',
      'VirtualClip',
      'DerivedClip',
    ]);
    assert.deepEqual(allSymbolsToMove, expectedSymbols);
  });

  test('complex nested type dependency chains', () => {
    const source = `
export interface BaseType {
  id: string;
}

export interface MiddleType extends BaseType {
  data: NestedData;
}

export interface NestedData {
  value: string;
  metadata: Metadata;
}

export interface Metadata {
  created: string;
}

export interface ComplexItem {
  info: MiddleType;
}

export interface UnrelatedType {
  other: string;
}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);

    const allSymbolsToMove = collectAllRequiredDeps(deps, ['ComplexItem']);

    assert.isTrue(allSymbolsToMove.has('MiddleType'));
    assert.isTrue(allSymbolsToMove.has('BaseType'));
    assert.isTrue(allSymbolsToMove.has('NestedData'));
    assert.isTrue(allSymbolsToMove.has('Metadata'));
    assert.isFalse(allSymbolsToMove.has('UnrelatedType'));
  });

  test('object literal property keys are not treated as symbol references', () => {
    const source = `
import { z } from 'zod';

export const mySchema = z.string().meta({
  description: 'A string field',
  example: 'hello'
});

export type MyType = z.infer<typeof mySchema>;

export const otherSchema = z.number();
`;
    const sourceFile = createTestSourceFile(source);
    const staticModuleInfo = parseModule(sourceFile);

    const mySchemaUses = getOrThrow(
      staticModuleInfo.identifierUses,
      'mySchema',
      'mySchema identifiers should exist',
    );
    assert.notInclude(mySchemaUses, 'description');
    assert.notInclude(mySchemaUses, 'example');
    assert.include(mySchemaUses, 'z');

    const deps = buildIntraModuleDependencies(staticModuleInfo, source);
    const analysis = analyzeSplit(deps, 'mySchema');
    assert.isTrue(analysis.canSplit);
  });
});

describe('analyzeImportUsageFromStaticInfo', () => {
  test('analyzes import usage per symbol', () => {
    const source = `
import { helper, validator } from './utils';
import { format } from 'date-fns';

export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

function formatISODate(date: Date): string {
  return date.toISOString();
}

export function validateEmail(email: string): boolean {
  return validator(email) && helper(email);
}

function processData(data: unknown): unknown {
  return helper(data);
}
`;
    const sourceFile = createTestSourceFile(source);
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );

    // formatISODate references only Date (built-in) so it has no import usage and is excluded.
    assert.equal(importUsages.length, 3);

    const usageMap = new Map(importUsages.map((u) => [u.symbol, u]));
    const formatDateUsage = getOrThrow(
      usageMap,
      'formatDate',
      'formatDate usage should be found',
    );
    assert.lengthOf(formatDateUsage.usesImports, 1);
    // biome-ignore lint/style/noNonNullAssertion: length check guarantees at(0) is defined
    const firstImport = formatDateUsage.usesImports.at(0)!;
    assert.equal(firstImport.moduleSpec, 'date-fns');
    assert.equal(firstImport.importedName, 'format');

    const validateEmailUsage = getOrThrow(
      usageMap,
      'validateEmail',
      'validateEmail usage should be found',
    );
    assert.equal(validateEmailUsage.usesImports.length, 2);
    const usedImports = validateEmailUsage.usesImports
      .map((imp) => imp.importedName)
      .sort();
    assert.deepEqual(usedImports, ['helper', 'validator']);
  });

  test('finds imports only used by target symbols', () => {
    const source = `
import { helper, validator, shared } from './utils';
import { format } from 'date-fns';

export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd') + shared;
}

export function validateEmail(email: string): boolean {
  return validator(email) && shared.length > 0;
}

function internalHelper(): string {
  return helper('test') + shared;
}
`;
    const sourceFile = createTestSourceFile(source);
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const targetSymbols = new Set(['formatDate']);
    const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
      importUsages,
      targetSymbols,
    );

    assert.isTrue(onlyUsedByTarget.has('date-fns:format'));
    assert.isFalse(onlyUsedByTarget.has('./utils:shared'));
    assert.isFalse(onlyUsedByTarget.has('./utils:validator'));
    assert.isFalse(onlyUsedByTarget.has('./utils:helper'));
  });
});

describe('extractSymbolDefinitions', () => {
  test('extracts function definitions with metadata', () => {
    const source = `
import { helper } from './utils';

/**
 * Formats a date to ISO string
 */
export function formatDate(date: Date): string {
  return formatISODate(date);
}

function formatISODate(date: Date): string {
  return date.toISOString();
}

export function validateEmail(email: string): boolean {
  return email.includes('@') && helper(email);
}

const CONSTANT_VALUE = 42;
`;
    const sourceFile = createTestSourceFile(source);
    const symbolsToExtract = new Set([
      'formatDate',
      'formatISODate',
      'CONSTANT_VALUE',
    ]);
    const definitions = extractSymbolDefinitions(sourceFile, symbolsToExtract);

    assert.equal(definitions.length, 3);

    const defMap = new Map(definitions.map((d) => [d.name, d]));
    const formatDate = getOrThrow(
      defMap,
      'formatDate',
      'formatDate definition should be found',
    );
    assert.equal(formatDate.kind, 'function');
    assert.isTrue(formatDate.isExported);
    assertDefined(formatDate.jsDocs, 'formatDate should have jsDocs');
    assertDefined(
      formatDate.jsDocs[0],
      'formatDate should have a JSDoc comment',
    );
    const firstDoc = formatDate.jsDocs[0];
    assert.include(firstDoc.getInnerText(), 'Formats a date to ISO string');

    const formatISODate = getOrThrow(
      defMap,
      'formatISODate',
      'formatISODate definition should be found',
    );
    assert.equal(formatISODate.kind, 'function');
    assert.isFalse(formatISODate.isExported);

    const constant = getOrThrow(
      defMap,
      'CONSTANT_VALUE',
      'CONSTANT_VALUE definition should be found',
    );
    assert.equal(constant.kind, 'const');
  });

  test('extracts interface with method signatures', () => {
    const source = `
export interface MyOperations {
  vfs: string;

  /**
   * Method signature with JSDoc
   */
  readFile(filePath: string): Promise<string>;

  writeFile(outputFile: string, content: string): Promise<void>;
}

export function useOperations(ops: MyOperations): void {}
`;
    const sourceFile = createTestSourceFile(source);
    const symbolsToMove = new Set(['MyOperations']);
    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );

    assert.lengthOf(symbolDefinitions, 1);
    // biome-ignore lint/style/noNonNullAssertion: length check guarantees at(0) is defined
    const def = symbolDefinitions.at(0)!;
    assert.equal(def.name, 'MyOperations');
    assert.equal(def.kind, 'interface');

    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {},
    );

    const newModuleSource = generateNewModuleSource(
      symbolDefinitions,
      requiredImports,
      {},
    );

    assert.include(newModuleSource, 'vfs: string');
    assert.include(
      newModuleSource,
      'readFile(filePath: string): Promise<string>',
    );
    assert.include(
      newModuleSource,
      'writeFile(outputFile: string, content: string): Promise<void>',
    );
    assert.include(newModuleSource, 'Method signature with JSDoc');
  });

  test('interface extraction preserves all members', () => {
    const source = `
export interface Operations {
  prop: number;
  method(): void;
}
`;
    const sourceFile = createTestSourceFile(source);
    const originalInterface = sourceFile.getInterface('Operations');
    assertDefined(originalInterface, 'Interface should exist');
    assert.equal(originalInterface.getProperties().length, 1);
    assert.equal(originalInterface.getMethods().length, 1);
    assert.equal(originalInterface.getMembers().length, 2);

    const symbolsToMove = new Set(['Operations']);
    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {},
    );
    const newModuleSource = generateNewModuleSource(
      symbolDefinitions,
      requiredImports,
      {},
    );

    const newProject = new Project({ useInMemoryFileSystem: true });
    const newFile = newProject.createSourceFile('new.ts', newModuleSource);
    const generatedInterface = newFile.getInterface('Operations');
    assertDefined(generatedInterface, 'Generated interface should exist');
    assert.equal(generatedInterface.getProperties().length, 1);
    assert.equal(generatedInterface.getMethods().length, 1);
    assert.equal(generatedInterface.getMembers().length, 2);
  });
});

describe('generateNewModuleSource', () => {
  test('generates module with imports and symbols', () => {
    const source = `
import { format } from 'date-fns';
import { helper, validator } from './utils';

/**
 * Formats a date to ISO string
 */
export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

function formatISODate(date: Date): string {
  return date.toISOString();
}

export function validateEmail(email: string): boolean {
  return validator(email) && helper(email);
}

const API_URL = 'https://api.example.com';
`;
    const sourceFile = createTestSourceFile(source);
    const symbolsToMove = new Set(['formatDate', 'formatISODate']);
    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {},
    );
    const newModuleSource = generateNewModuleSource(
      symbolDefinitions,
      requiredImports,
      {},
    );

    assert.include(newModuleSource, 'import { format } from "date-fns";');
    assert.include(
      newModuleSource,
      'export function formatDate(date: Date): string',
    );
    assert.include(
      newModuleSource,
      'function formatISODate(date: Date): string',
    );
    assert.include(newModuleSource, 'Formats a date to ISO string');
    assert.notInclude(newModuleSource, './utils');
  });

  test('generates module with mixed exports and internal symbols', () => {
    const source = `
export function publicFunction(): string {
  return helper();
}

function helper(): string {
  return CONSTANT;
}

const CONSTANT = 'value';
`;
    const sourceFile = createTestSourceFile(source);
    const symbolsToMove = new Set(['publicFunction', 'helper', 'CONSTANT']);
    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const newModuleSource = generateNewModuleSource(symbolDefinitions, [], {});

    assert.include(newModuleSource, 'export function publicFunction()');
    assert.include(newModuleSource, 'function helper()');
    assert.include(newModuleSource, "const CONSTANT = 'value';");
  });
});

describe('removeSymbolsFromSource', () => {
  test('removes symbols from original source', () => {
    const source = `
import { format } from 'date-fns';
import { helper, validator } from './utils';

/**
 * Formats a date to ISO string
 */
export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

function formatISODate(date: Date): string {
  return date.toISOString();
}

export function validateEmail(email: string): boolean {
  return validator(email) && helper(email);
}

const API_URL = 'https://api.example.com';
const DEBUG = true;
`;
    const symbolsToRemove = new Set(['formatDate', 'formatISODate']);
    const modifiedSource = removeSymbolsFromSource(source, symbolsToRemove);

    assert.notInclude(modifiedSource, 'function formatDate');
    assert.notInclude(modifiedSource, 'function formatISODate');
    assert.include(modifiedSource, 'function validateEmail');
    assert.include(modifiedSource, 'const API_URL');
    assert.include(modifiedSource, 'const DEBUG');
  });

  test('preserves blank lines between remaining symbols', () => {
    const source = `const stayingA = 1;

const movingB = 2;

/**
 * Staying C
 */
const stayingC = 3;
`;
    const result = removeSymbolsFromSource(source, new Set(['movingB']));

    assert.include(result, 'stayingA');
    assert.include(result, 'stayingC');
    assert.notInclude(result, 'movingB');
    assert.match(result, /stayingA\s*=\s*1;\n\n\/\*\*/);
  });

  test('handles partial declaration removal across multiple variable statements', () => {
    // Regression: partial removal from a second variable statement must not throw.
    const source = `export const keepA = 1, moveB = 2;
const moveC = 3, keepD = 4;
`;
    const result = removeSymbolsFromSource(source, new Set(['moveB', 'moveC']));

    assert.include(result, 'keepA');
    assert.include(result, 'keepD');
    assert.notInclude(result, 'moveB');
    assert.notInclude(result, 'moveC');
  });
});

describe('removeUnusedImports', () => {
  test('removes unused imports after symbol removal', () => {
    const source = `
import { format } from 'date-fns';
import { helper, validator } from './utils';

export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function validateEmail(email: string): boolean {
  return validator(email) && helper(email);
}
`;
    const onlyUsedByRemoved = new Set(['date-fns:format']);
    const modifiedSource = removeUnusedImports(source, onlyUsedByRemoved);

    assert.notInclude(modifiedSource, "import { format } from 'date-fns'");
    assert.include(
      modifiedSource,
      "import { helper, validator } from './utils'",
    );
  });

  test('removes default imports only used by moved symbols', () => {
    const source = `
import * as unrelatedImport from 'some-module';
import packageInfo from '../package.json';

function helperFunction(): string {
  return packageInfo.version;
}

export function functionToExtract(): string {
  return \`version: \${helperFunction()}\`;
}

export function otherFunction(): string {
  return unrelatedImport.doSomething();
}
`;
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('subdir/source.ts', source);
    const symbolsToMove = new Set(['functionToExtract', 'helperFunction']);
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
      importUsages,
      symbolsToMove,
    );

    assert.isTrue(
      onlyUsedByTarget.has('../package.json:packageInfo'),
      'packageInfo should be identified as only used by target symbols',
    );

    const modifiedSource = removeUnusedImports(
      removeSymbolsFromSource(source, symbolsToMove),
      onlyUsedByTarget,
    );

    assert.include(
      modifiedSource,
      "import * as unrelatedImport from 'some-module'",
    );
    assert.notInclude(
      modifiedSource,
      "import packageInfo from '../package.json'",
    );
    assert.include(modifiedSource, 'export function otherFunction');
  });

  test('preserves type keyword on import when removing partial named imports', () => {
    const source = `import type { Item, Unused } from './types';\nconst x: Item = {};`;
    const onlyUsedByRemoved = new Set(['./types:Unused']);
    const modifiedSource = removeUnusedImports(source, onlyUsedByRemoved);

    // type keyword must be preserved
    assert.include(
      modifiedSource,
      "import type { Item } from './types'",
      'type keyword must be preserved on partial removal',
    );
    assert.notInclude(modifiedSource, 'Unused');
  });

  test('preserves import aliases when removing partial named imports', () => {
    /*
      Aliased imports must keep the alias. Without this, the local binding
      changes (e.g., 'MyItem' becomes undefined because it was replaced
      with a non-aliased 'Item').
    */
    const source = `import { Item as MyItem, Unused } from './source';\nconst x: MyItem = {};`;
    const onlyUsedByRemoved = new Set(['./source:Unused']);
    const modifiedSource = removeUnusedImports(source, onlyUsedByRemoved);

    assert.include(
      modifiedSource,
      'Item as MyItem',
      'Alias must be preserved',
    );
    assert.notInclude(modifiedSource, 'Unused');
  });

  test('preserves inline type keyword when removing partial named imports', () => {
    /*
      TypeScript 4.5+ allows inline type keywords:
      `import { type A, B } from '...'`
      These must not be stripped when other imports are removed.
    */
    const source = `import { type Item, Other, type Unused } from './types';\nconst x: Item = {};`;
    const onlyUsedByRemoved = new Set(['./types:Unused']);
    const modifiedSource = removeUnusedImports(source, onlyUsedByRemoved);

    assert.include(
      modifiedSource,
      'type Item',
      'Inline type keyword must be preserved',
    );
    assert.include(modifiedSource, 'Other');
    assert.notInclude(modifiedSource, 'Unused');
  });
});

describe('addImportForMovedSymbols', () => {
  test('adds re-export for moved symbols', () => {
    const source = `
export function formatDate(date: Date): string {
  return formatISODate(date);
}

function formatISODate(date: Date): string {
  return date.toISOString();
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}

const API_URL = 'https://api.example.com';
`;
    const movedSymbols = new Set(['formatDate', 'formatISODate']);
    const sourceFile = createTestSourceFile(source);
    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      movedSymbols,
    );

    const cleanedSource = removeSymbolsFromSource(source, movedSymbols);
    const modifiedSource = addImportForMovedSymbols(
      cleanedSource,
      movedSymbols,
      './date-utils',
      true,
      { symbolDefinitions },
    );

    assert.notMatch(
      modifiedSource,
      /^import.*formatDate/m,
      'Should not have import statement when only re-exporting',
    );
    assert.include(modifiedSource, 'export { formatDate, formatISODate }');
    assert.include(modifiedSource, 'function validateEmail');
    assert.include(modifiedSource, 'const API_URL');
  });
});

describe('computeRequiredImports', () => {
  test('adjusts relative import paths for new location', () => {
    const source = `
import packageInfo from '../../package.json';

function helperFunction(): string {
  return packageInfo.version;
}

export function functionToExtract(): string {
  return \`version: \${helperFunction()}\`;
}
`;
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      'clients/kelda/commands/run.ts',
      source,
    );
    const symbolsToMove = new Set(['functionToExtract', 'helperFunction']);
    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {
        sourceFilePath: 'clients/kelda/commands/run.ts',
        targetFilePath: 'clients/kelda/dockerImage.ts',
      },
    );

    assert.lengthOf(requiredImports, 1);
    // biome-ignore lint/style/noNonNullAssertion: length check guarantees at(0) is defined
    const firstImport = requiredImports.at(0)!;
    assert.equal(firstImport.moduleSpec, '../package.json');
  });
});

describe('interface method type references', () => {
  test('detects type references in interface method signatures', () => {
    const source = `
import type { Logger } from './logger';
import type { RequestHandler } from './handler';
import type { BackendOps } from './backend';

export interface Operations {
  readFile(filePath: string): Promise<string>;
  processRequest(logger: Logger, handler: RequestHandler, backend: BackendOps): Promise<void>;
  cleanup(logger: Logger): Promise<void>;
}
`;
    const sourceFile = createTestSourceFile(source);
    const moduleInfo = parseModule(sourceFile);

    assert.isTrue(moduleInfo.exportedNames.has('Operations'));
    const operationsIdentifiers = getOrThrow(
      moduleInfo.identifierUses,
      'Operations',
      'Operations identifiers should exist',
    );
    assert.include(operationsIdentifiers, 'Logger');
    assert.include(operationsIdentifiers, 'RequestHandler');
    assert.include(operationsIdentifiers, 'BackendOps');
  });

  test('detects type references in return types', () => {
    const source = `
import type { User } from './user';
import type { Result } from './result';

export interface UserService {
  getUser(id: string): Promise<User>;
  updateUser(user: User): Result<User>;
}
`;
    const sourceFile = createTestSourceFile(source);
    const moduleInfo = parseModule(sourceFile);
    const identifiers = getOrThrow(
      moduleInfo.identifierUses,
      'UserService',
      'UserService identifiers should exist',
    );
    assert.include(identifiers, 'User');
    assert.include(identifiers, 'Result');
  });

  test('detects type references in complex signatures with utility types', () => {
    const source = `
import type { Logger } from './logger';
import type { Config } from './config';

export interface Service {
  hardLinkOrCopy(filePath: string, keldaCfg: Pick<Config, 'serverFolder'>, logger: Logger): Promise<void>;
  getPartial(data: Partial<Config>): Config;
}
`;
    const sourceFile = createTestSourceFile(source);
    const moduleInfo = parseModule(sourceFile);
    const identifiers = getOrThrow(
      moduleInfo.identifierUses,
      'Service',
      'Service identifiers should exist',
    );
    assert.include(identifiers, 'Config');
    assert.include(identifiers, 'Logger');
  });
});

describe('global identifiers', () => {
  test('are not treated as local definitions', () => {
    const source = `
export class Guard {
  private _promise: Promise<void> | null = null;

  constructor() {
    this._promise = new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }

  async wait(): Promise<void> {
    await this._promise;
  }
}

export function otherFunction(): string {
  return new Date().toISOString();
}
`;
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('async.ts', source);
    const staticModuleInfo = parseModule(sourceFile);
    const dependencies = buildIntraModuleDependencies(staticModuleInfo, source);

    assert.isFalse(dependencies.definitions.has('Promise'));
    assert.isFalse(dependencies.definitions.has('Date'));
    assert.isFalse(dependencies.definitions.has('setTimeout'));

    const symbolsToMove = collectAllRequiredDeps(dependencies, ['Guard']);

    assert.isFalse(symbolsToMove.has('Promise'));
    assert.isFalse(symbolsToMove.has('Date'));

    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
      importUsages,
      symbolsToMove,
    );
    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {
        sourceFilePath: 'async.ts',
        targetFilePath: 'guard.ts',
      },
    );

    for (const imp of requiredImports) {
      for (const name of imp.importedNames) {
        assert.notEqual(name, 'Promise');
        assert.notEqual(name, 'Date');
      }
    }

    const cleanedSource = removeUnusedImports(
      removeSymbolsFromSource(source, symbolsToMove),
      onlyUsedByTarget,
    );
    const finalSource = addImportForMovedSymbols(
      cleanedSource,
      new Set(['Guard']),
      './guard',
      true,
      { symbolDefinitions },
    );

    assert.notMatch(finalSource, /import.*Promise.*from.*guard/);
    assert.notMatch(finalSource, /import.*Date.*from.*guard/);
  });
});

describe('shared imports', () => {
  test('are preserved in source and added to target module', () => {
    const source = `
import { z } from 'zod';
import { helper } from './utils';

export const movingSchema = z.object({
  field: z.string()
});

export const stayingSchema = z.object({
  source: helper()
});
`;
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('source.ts', source);
    const staticModuleInfo = parseModule(sourceFile);
    const dependencies = buildIntraModuleDependencies(staticModuleInfo, source);

    const symbolsToMove = collectAllRequiredDeps(dependencies, [
      'movingSchema',
    ]);

    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
      importUsages,
      symbolsToMove,
    );

    assert.isFalse(onlyUsedByTarget.has('zod:z'));
    assert.isFalse(onlyUsedByTarget.has('./utils:helper'));

    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {
        sourceFilePath: 'source.ts',
        targetFilePath: 'target.ts',
      },
    );

    const zodImport = requiredImports.find((imp) => imp.moduleSpec === 'zod');
    assertDefined(zodImport, 'zodImport should be defined');
    assert.include(zodImport.importedNames, 'z');

    const utilsImport = requiredImports.find(
      (imp) => imp.moduleSpec === './utils',
    );
    assert.isUndefined(utilsImport);

    const cleanedSource = removeUnusedImports(
      removeSymbolsFromSource(source, symbolsToMove),
      onlyUsedByTarget,
    );

    assert.include(cleanedSource, "import { z } from 'zod'");
    assert.include(cleanedSource, "import { helper } from './utils'");
  });

  test('shared non-exported dependency is exported from target and imported in source', () => {
    const source = `
import { z } from 'zod';

const sharedSchema = z.object({
  field: z.string()
});

const stayingSchema = z.object({
  source: sharedSchema
});

export const movingSchema = z.object({
  location: sharedSchema
});
`;
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('source.ts', source);
    const staticModuleInfo = parseModule(sourceFile);
    const dependencies = buildIntraModuleDependencies(staticModuleInfo, source);

    const analysis = analyzeSplit(dependencies, 'movingSchema');
    assert.isTrue(analysis.canSplit);

    const symbolsToMove = collectAllRequiredDeps(dependencies, [
      'movingSchema',
    ]);

    assert.isTrue(symbolsToMove.has('sharedSchema'));

    const sharedNonExportedDeps = findSharedNonExportedDeps(
      dependencies,
      symbolsToMove,
    );
    assert.isTrue(sharedNonExportedDeps.has('sharedSchema'));

    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
      importUsages,
      symbolsToMove,
    );
    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {
        sourceFilePath: 'source.ts',
        targetFilePath: 'target.ts',
      },
    );
    const targetContent = generateNewModuleSource(
      symbolDefinitions,
      requiredImports,
      { additionalExports: sharedNonExportedDeps },
    );

    assert.match(targetContent, /export\s+const\s+sharedSchema/);

    const cleanedSource = removeUnusedImports(
      removeSymbolsFromSource(source, symbolsToMove),
      onlyUsedByTarget,
    );

    const finalSource = addImportForMovedSymbols(
      cleanedSource,
      sharedNonExportedDeps,
      './target',
      false,
      { symbolDefinitions },
    );

    assert.match(
      finalSource,
      /import\s*\{[^}]*sharedSchema[^}]*\}\s*from\s*'\.\/target'/,
    );
    assert.notMatch(finalSource, /export\s*\{[^}]*sharedSchema/);
    assert.include(finalSource, 'stayingSchema');
  });
});

describe('re-export behavior', () => {
  test('re-exports do not create unused imports', () => {
    const source = `
export interface ItemDto {
  id: string;
}

export const CONFIG = ['a', 'b'] as const;
export type ConfigType = typeof CONFIG[number];

export interface CustomData {
  value: string;
}
`;
    const moduleInfo = parseModule(createTestSourceFile(source));
    const deps = buildIntraModuleDependencies(moduleInfo, source);
    const symbolsToMove = new Set(['CustomData']);
    const analysis = analyzeSplit(deps, 'CustomData');
    assert.equal(analysis.requiredDependencies.size, 0);

    const sourceFile = createTestSourceFile(source);
    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {},
    );
    const newModuleSource = generateNewModuleSource(
      symbolDefinitions,
      requiredImports,
      {},
    );

    assert.include(newModuleSource, 'export interface CustomData');

    const cleanedSource = removeSymbolsFromSource(source, symbolsToMove);
    const finalSource = addImportForMovedSymbols(
      cleanedSource,
      symbolsToMove,
      './target',
      true,
      { symbolDefinitions },
    );

    assert.include(finalSource, 'export interface ItemDto');
    assert.include(finalSource, 'export const CONFIG');
    assert.notMatch(finalSource, /^import.*CustomData/m);
    assert.match(finalSource, /export type \{[^}]*CustomData[^}]*\}/);
  });

  test('complete split workflow with type/value separation', () => {
    const moduleInfo = parseModule(createTestSourceFile(TYPEOF_CONST_FIXTURE));
    const deps = buildIntraModuleDependencies(moduleInfo, TYPEOF_CONST_FIXTURE);
    const symbolsToMove = new Set([
      'DerivedFromConst',
      'UsesImportedType',
      'MappedTypeUsingImport',
    ]);

    const allRequired = collectAllRequiredDeps(deps, symbolsToMove);

    assert.isTrue(allRequired.has('myConstArray'));

    const sourceFile = createTestSourceFile(TYPEOF_CONST_FIXTURE);
    const symbolDefinitions = extractSymbolDefinitions(sourceFile, allRequired);
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {},
    );
    const newModuleSource = generateNewModuleSource(
      symbolDefinitions,
      requiredImports,
      {},
    );

    assert.include(newModuleSource, 'export const myConstArray');
    assert.include(newModuleSource, 'export type DerivedFromConst');
    assert.include(newModuleSource, 'export interface UsesImportedType');
    assert.include(newModuleSource, 'export type MappedTypeUsingImport');

    const cleanedSource = removeSymbolsFromSource(
      TYPEOF_CONST_FIXTURE,
      allRequired,
    );
    const finalSource = addImportForMovedSymbols(
      cleanedSource,
      allRequired,
      './itemDeps',
      true,
      { symbolDefinitions },
    );

    assert.include(finalSource, 'export interface Item');
    assert.match(finalSource, /^import type.*DerivedFromConst/m);
    assert.match(finalSource, /^import type.*UsesImportedType/m);
    assert.match(finalSource, /^import type.*MappedTypeUsingImport/m);
    assert.match(finalSource, /export type \{[^}]*DerivedFromConst[^}]*\}/);
    assert.match(finalSource, /export type \{[^}]*UsesImportedType[^}]*\}/);
    assert.match(
      finalSource,
      /export type \{[^}]*MappedTypeUsingImport[^}]*\}/,
    );
    assert.match(finalSource, /export \{[^}]*myConstArray[^}]*\}/);
  });
});

describe('real-world combined scenario', () => {
  test('default import removal and path adjustment together', () => {
    const source = `
import * as dotenv from 'env-cmd';
import packageInfo from '../../../package.json';

function getDefaultDockerImageVersion(): string {
  return packageInfo.version;
}

export function getDefaultKeldaDockerImage(): string {
  return \`docker.io/mjoll/kelda\${process.arch === 'arm64' ? '-aarch64' : ''}:\${getDefaultDockerImageVersion()}\`;
}

export function parseArgs(args: string[]): string {
  const config = dotenv.GetEnvVars({ rcFile: '.env' });
  return config.someValue;
}
`;
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      'clients/kelda/tools/kelda/commands/run.ts',
      source,
    );
    const symbolsToMove = new Set([
      'getDefaultKeldaDockerImage',
      'getDefaultDockerImageVersion',
    ]);
    const symbolDefinitions = extractSymbolDefinitions(
      sourceFile,
      symbolsToMove,
    );
    const importUsages = analyzeImportUsageFromStaticInfo(
      parseModule(sourceFile),
    );
    const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
      importUsages,
      symbolsToMove,
    );

    const modifiedSource = removeUnusedImports(
      removeSymbolsFromSource(source, symbolsToMove),
      onlyUsedByTarget,
    );

    assert.include(modifiedSource, "import * as dotenv from 'env-cmd'");
    assert.include(modifiedSource, 'export function parseArgs');
    assert.notInclude(modifiedSource, 'import packageInfo from');

    const requiredImports = computeRequiredImports(
      symbolDefinitions,
      importUsages,
      {
        sourceFilePath: 'clients/kelda/tools/kelda/commands/run.ts',
        targetFilePath: 'clients/kelda/tools/kelda/keldaDockerImage.ts',
      },
    );

    const packageImport = requiredImports.find((imp) =>
      imp.moduleSpec.includes('package.json'),
    );
    assertDefined(packageImport, 'packageImport should be defined');
    assert.equal(packageImport.moduleSpec, '../../package.json');
  });
});
