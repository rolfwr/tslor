import { assert, test } from 'vitest';
import { parseIsolatedSourceCode } from './parseIsolatedSourceCode.js';
import { parseModule, analyzeImportUsageFromStaticInfo } from './indexing.js';
import { invariant, assertDefined } from './invariant.js';
import { 
  Project, 
  SourceFile, 
  SyntaxKind, 
  FunctionDeclaration,
  VariableStatement,
  VariableDeclaration
} from 'ts-morph';
import {
  buildIntraModuleDependencies,
  detectCircularDependencies,
  analyzeSplit,
  extractSymbolDefinitions,
  analyzeImportUsageBySymbol,
  findImportsOnlyUsedBySymbols,
  computeRequiredImports,
  generateNewModuleSource,
  removeSymbolsFromSource,
  removeUnusedImports,
  addImportForMovedSymbols
} from './splitModule.js';

/**
 * Create a source file from source code for testing
 */
function createTestSourceFile(sourceCode: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('test.ts', sourceCode);
}

test('Parse simple internal dependency', () => {
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

  const moduleInfo = parseIsolatedSourceCode(source);
  
  // Should identify exports
  assert.hasAllKeys(moduleInfo.exports, ['formatDate', 'validateEmail']);
  
  // Should track that formatDate uses formatISODate
  const formatDateExport = moduleInfo.exports.get('formatDate');
  assert.isDefined(formatDateExport);
  
  // Build dependency graph
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  // formatDate should depend on formatISODate
  const formatDateDeps = deps.dependencies.get('formatDate');
  assert.isDefined(formatDateDeps);
  assertDefined(formatDateDeps, 'formatDateDeps should be defined');
  assert.isTrue(formatDateDeps.has('formatISODate'));
  
  // validateEmail should have no internal dependencies
  const validateEmailDeps = deps.dependencies.get('validateEmail');
  assert.isDefined(validateEmailDeps);
  assertDefined(validateEmailDeps, 'validateEmailDeps should be defined');
  assert.equal(validateEmailDeps.size, 0);
});

test('Parse transitive internal dependencies', () => {
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

export function otherFunction(): void {
  // Independent function
}
`;

  const moduleInfo = parseIsolatedSourceCode(source);
  
  // Build dependency graph and analyze transitive dependencies
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  // Analyze splitting processData
  const splitAnalysis = analyzeSplit(deps, 'processData');
  
  assert.equal(splitAnalysis.symbolToMove, 'processData');
  assert.isTrue(splitAnalysis.canSplit, 'Should be able to split - no circular deps');
  
  // processData should transitively depend on validateInput, sanitizeInput, formatOutput
  const expectedDeps = new Set(['validateInput', 'sanitizeInput', 'formatOutput']);
  assert.deepEqual(splitAnalysis.requiredDependencies, expectedDeps);
  
  // otherFunction should have no dependencies
  const otherSplit = analyzeSplit(deps, 'otherFunction');
  assert.equal(otherSplit.requiredDependencies.size, 0);
});

test('Parse circular internal dependencies', () => {
  const source = `
export function funcA(): string {
  return funcB() + 'A';
}

function funcB(): string {
  return funcC() + 'B';
}

function funcC(): string {
  return funcA() + 'C';  // Creates cycle
}

export function independent(): string {
  return 'standalone';
}
`;

  const moduleInfo = parseIsolatedSourceCode(source);
  
  // Build dependency graph and detect cycles
  const deps = buildIntraModuleDependencies(moduleInfo);
  const cycles = detectCircularDependencies(deps);
  
  // Should detect the circular dependency
  assert.isTrue(cycles.length > 0, 'Should detect circular dependencies');
  
  // Try to split funcA - should fail due to circular dependency
  const splitAnalysis = analyzeSplit(deps, 'funcA');
  assert.isFalse(splitAnalysis.canSplit, 'Should not be able to split due to circular deps');
  assert.isTrue(splitAnalysis.circularDependencies.length > 0, 'Should report circular dependencies');
  
  // independent should be splittable
  const independentSplit = analyzeSplit(deps, 'independent');
  assert.isTrue(independentSplit.canSplit, 'independent should be splittable');
  assert.equal(independentSplit.requiredDependencies.size, 0, 'independent should have no deps');
});

test('Split analysis with shared dependencies', () => {
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

  const moduleInfo = parseIsolatedSourceCode(source);
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  // Analyze splitting formatUser
  const formatUserSplit = analyzeSplit(deps, 'formatUser');
  assert.isTrue(formatUserSplit.canSplit);
  
  // formatUser needs formatName, formatEmail, and capitalize (transitively)
  const expectedDeps = new Set(['formatName', 'formatEmail', 'capitalize']);
  assert.deepEqual(formatUserSplit.requiredDependencies, expectedDeps);
  
  // Analyze splitting displayUser  
  const displayUserSplit = analyzeSplit(deps, 'displayUser');
  assert.isTrue(displayUserSplit.canSplit);
  
  // displayUser needs formatName and capitalize (transitively)
  const expectedDisplayDeps = new Set(['formatName', 'capitalize']);
  assert.deepEqual(displayUserSplit.requiredDependencies, expectedDisplayDeps);
  
  // This shows the shared dependency problem: both exports need formatName and capitalize
  // In a real implementation, we'd need to decide how to handle this
});

test('Handle symbol duplication in allDefinedSymbols correctly', () => {
  // Test for the issue identified in buildIntraModuleDependencies where symbols
  // are added to allDefinedSymbols multiple times with unclear logic
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

  const moduleInfo = parseIsolatedSourceCode(source);
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  // allDefinedSymbols should not contain duplicates
  const definitionsArray = Array.from(deps.definitions);
  const uniqueDefinitions = [...new Set(definitionsArray)];
  assert.equal(definitionsArray.length, uniqueDefinitions.length, 'definitions should not contain duplicates');
  
  // Should properly distinguish between defined symbols and external references
  // trim() and toUpperCase() should not be in definitions (they're built-in methods)
  assert.isFalse(deps.definitions.has('trim'), 'built-in methods should not be in definitions');
  assert.isFalse(deps.definitions.has('toUpperCase'), 'built-in methods should not be in definitions');
  
  // All actual function names should be in definitions
  assert.isTrue(deps.definitions.has('processData'));
  assert.isTrue(deps.definitions.has('validateInput'));
  assert.isTrue(deps.definitions.has('sanitizeInput'));
  assert.isTrue(deps.definitions.has('formatOutput'));
});

test('Handle circular dependency detection properly', () => {
  // Test the calculateAccumulatedExports function for proper circular dependency handling
  const circularSource = `
export function funcA(): string {
  return funcB() + 'A';
}

function funcB(): string {
  return funcC() + 'B';
}

function funcC(): string {
  return funcA() + 'C';  // Creates cycle: A -> B -> C -> A
}
`;

  const moduleInfo = parseIsolatedSourceCode(circularSource);
  
  // Should not cause infinite recursion
  // Should properly handle the circular reference in export calculation
  const funcAExport = moduleInfo.exports.get('funcA');
  assert.isDefined(funcAExport, 'funcA should be exported');
  
  // The circular dependency should be detected and handled gracefully
  // (exact behavior depends on implementation, but should not crash)
  assert.isArray(funcAExport?.uses, 'uses should be an array');
});

test('Verify StaticModuleInfo analysis matches SourceFile analysis', () => {
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
  
  // Old approach: analyze using SourceFile
  const oldImportUsages = analyzeImportUsageBySymbol(sourceFile);
  
  // New approach: analyze using StaticModuleInfo
  const staticModuleInfo = parseModule(sourceFile);
  const newImportUsages = analyzeImportUsageFromStaticInfo(staticModuleInfo);
  
  // Should produce equivalent results
  assert.equal(oldImportUsages.length, newImportUsages.length, 'Should analyze same number of symbols');
  
  // Sort both arrays by symbol name for comparison
  const sortedOld = [...oldImportUsages].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const sortedNew = [...newImportUsages].sort((a, b) => a.symbol.localeCompare(b.symbol));
  
  for (let i = 0; i < sortedOld.length; i++) {
    const oldUsage = sortedOld[i];
    const newUsage = sortedNew[i];
    
    assert.equal(oldUsage.symbol, newUsage.symbol, `Symbol names should match at index ${i}`);
    assert.equal(oldUsage.usesImports.length, newUsage.usesImports.length, 
      `Import count should match for symbol ${oldUsage.symbol}`);
    
    // Sort imports within each symbol for comparison
    const sortedOldImports = [...oldUsage.usesImports].sort((a, b) => `${a.moduleSpec}:${a.importedName}`.localeCompare(`${b.moduleSpec}:${b.importedName}`));
    const sortedNewImports = [...newUsage.usesImports].sort((a, b) => `${a.moduleSpec}:${a.importedName}`.localeCompare(`${b.moduleSpec}:${b.importedName}`));
    
    for (let j = 0; j < sortedOldImports.length; j++) {
      assert.equal(sortedOldImports[j].moduleSpec, sortedNewImports[j].moduleSpec, 
        `Module spec should match for ${oldUsage.symbol} import ${j}`);
      assert.equal(sortedOldImports[j].importedName, sortedNewImports[j].importedName, 
        `Import name should match for ${oldUsage.symbol} import ${j}`);
    }
  }
});

test('Handle complex import scenarios in split analysis (current support)', () => {
  // Test the complex import analysis with straightforward import syntax we do support
  // NOTE: This test validates the API consistency fix is working
  const source = `
import { format, parse } from 'date-fns';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { helper } from './utils';

export function processFile(filename: string, content: string): string {
  const parsed = parse(content, 'yyyy-MM-dd', new Date());
  const formatted = format(parsed, 'MM/dd/yyyy');
  const dir = dirname(filename);
  const fullPath = join(dir, 'output.txt');
  
  writeFileSync(fullPath, formatted);
  return helper(fullPath);
}

function internalProcessor(data: string): string {
  return format(new Date(), 'yyyy-MM-dd') + ': ' + data;
}

export function simpleFormat(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}
`;

  const sourceFile = createTestSourceFile(source);
  
  // Test that both analysis approaches work consistently
  const oldImportUsages = analyzeImportUsageBySymbol(sourceFile);
  const staticModuleInfo = parseModule(sourceFile);
  const newImportUsages = analyzeImportUsageFromStaticInfo(staticModuleInfo);
  
  // Should produce equivalent results
  assert.equal(oldImportUsages.length, newImportUsages.length, 'Should analyze same number of symbols');
  
  // Verify processFile has correct import dependencies
  const processFileUsage = newImportUsages.find(u => u.symbol === 'processFile');
  assert.isDefined(processFileUsage, 'processFile should be analyzed');
  
  // Should detect usage of multiple imports from different modules
  const expectedModules = new Set(['date-fns', 'fs', 'path', './utils']);
  const usedModules = new Set(processFileUsage!.usesImports.map(imp => imp.moduleSpec));
  assert.deepEqual(usedModules, expectedModules, 'Should detect imports from all used modules');
  
  // Test that we can successfully analyze symbols that use multiple imports
  const splitAnalysis = analyzeSplit(buildIntraModuleDependencies(staticModuleInfo), 'processFile');
  assert.isTrue(splitAnalysis.canSplit, 'Should be able to split complex function');
  
  console.log('Complex import analysis working with current API design ✅');
});

test.skip('Handle import aliases, namespaces, and defaults (normalize-first strategy)', () => {
  // NOTE: These import types are intentionally NOT supported in core refactoring logic:
  // import { format as dateFormat } from 'date-fns';  // Import aliases
  // import * as fs from 'fs';                         // Namespace imports  
  // import defaultParser from 'xml2js';              // Default imports
  
  // Design Decision: Use separate `tslor normalize-imports` command to convert these
  // to straightforward syntax before running refactoring operations.
  //
  // Benefits:
  // - Keeps core split logic simple and reliable
  // - Separates import normalization from module refactoring concerns
  // - More maintainable with fewer edge cases in critical refactoring path
  
  assert.isTrue(true, 'Placeholder - these will be handled by normalize-imports command');
});


test('Extract function definitions from source', () => {
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
  const symbolsToExtract = new Set(['formatDate', 'formatISODate', 'CONSTANT_VALUE']);
  const definitions = extractSymbolDefinitions(sourceFile, symbolsToExtract);
  
  // Should extract 3 definitions
  assert.equal(definitions.length, 3);
  
  // Check formatDate
  const formatDate = definitions.find(d => d.name === 'formatDate');
  assert.isDefined(formatDate);
  assertDefined(formatDate, 'formatDate definition should be found');
  assert.equal(formatDate.kind, 'function');
  assert.isTrue(formatDate.isExported);
  assert.isDefined(formatDate.jsDocs);
  assertDefined(formatDate.jsDocs, 'formatDate should have JSDoc');
  assert.isTrue(formatDate.jsDocs.length > 0);
  assert.include(formatDate.jsDocs[0].getInnerText(), 'Formats a date to ISO string');
  
  // Verify we have the actual AST node, not just text
  assert.isDefined(formatDate.node);
  invariant(formatDate.node.getKind() === SyntaxKind.FunctionDeclaration, 
    'formatDate node should be a FunctionDeclaration');
  assert.equal((formatDate.node as FunctionDeclaration).getName(), 'formatDate');
  
  // Check formatISODate (internal function)
  const formatISODate = definitions.find(d => d.name === 'formatISODate');
  assert.isDefined(formatISODate);
  assertDefined(formatISODate, 'formatISODate definition should be found');
  assert.equal(formatISODate.kind, 'function');
  assert.isFalse(formatISODate.isExported);
  assert.isDefined(formatISODate.node);
  invariant(formatISODate.node.getKind() === SyntaxKind.FunctionDeclaration, 
    'formatISODate node should be a FunctionDeclaration');
  assert.equal((formatISODate.node as FunctionDeclaration).getName(), 'formatISODate');
  
  // Check CONSTANT_VALUE
  const constant = definitions.find(d => d.name === 'CONSTANT_VALUE');
  assert.isDefined(constant);
  assertDefined(constant, 'CONSTANT_VALUE definition should be found');
  assert.equal(constant.kind, 'const');
  assert.isDefined(constant.node);
  // Verify it's a variable statement node
  invariant(constant.node.getKind() === SyntaxKind.VariableStatement, 
    'CONSTANT_VALUE node should be a VariableStatement');
  assert.isTrue((constant.node as VariableStatement).getDeclarations().some((decl: VariableDeclaration) => decl.getName() === 'CONSTANT_VALUE'));
});

test('Analyze import usage by symbols', () => {
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
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  
  // Should analyze 4 symbols
  assert.equal(importUsages.length, 4);
  
  // formatDate should use 'format' from 'date-fns'
  const formatDateUsage = importUsages.find(u => u.symbol === 'formatDate');
  assert.isDefined(formatDateUsage);
  assertDefined(formatDateUsage, 'formatDate usage should be found');
  assert.equal(formatDateUsage.usesImports.length, 1);
  assert.equal(formatDateUsage.usesImports[0].moduleSpec, 'date-fns');
  assert.equal(formatDateUsage.usesImports[0].importedName, 'format');
  
  // validateEmail should use both 'validator' and 'helper' from './utils'
  const validateEmailUsage = importUsages.find(u => u.symbol === 'validateEmail');
  assert.isDefined(validateEmailUsage);
  assertDefined(validateEmailUsage, 'validateEmail usage should be found');
  assert.equal(validateEmailUsage.usesImports.length, 2);
  const usedImports = validateEmailUsage.usesImports.map(imp => imp.importedName).sort();
  assert.deepEqual(usedImports, ['helper', 'validator']);
  
  // formatISODate should use no imports
  const formatISODateUsage = importUsages.find(u => u.symbol === 'formatISODate');
  assert.isDefined(formatISODateUsage);
  assertDefined(formatISODateUsage, 'formatISODate usage should be found');
  assert.equal(formatISODateUsage.usesImports.length, 0);
});

test('Find imports only used by target symbols', () => {
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
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  
  // If we're moving formatDate, which imports should move with it?
  const targetSymbols = new Set(['formatDate']);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, targetSymbols);
  
  // 'format' from 'date-fns' is only used by formatDate
  assert.isTrue(onlyUsedByTarget.has('date-fns:format'));
  
  // 'shared' is used by multiple symbols, so shouldn't be in the set
  assert.isFalse(onlyUsedByTarget.has('./utils:shared'));
  
  // 'validator' is only used by validateEmail, not formatDate
  assert.isFalse(onlyUsedByTarget.has('./utils:validator'));
  
  // 'helper' is only used by internalHelper, not formatDate
  assert.isFalse(onlyUsedByTarget.has('./utils:helper'));
});

test('Generate new module source with imports and symbols', () => {
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
  
  // Extract symbols we want to move (formatDate and its dependency)
  const symbolsToMove = new Set(['formatDate', 'formatISODate']);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  // Analyze import usage
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  
  // Compute required imports
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);
  
  // Generate new module source
  const newModuleSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  // Verify the generated source
  assert.include(newModuleSource, 'import { format } from "date-fns";');
  assert.include(newModuleSource, 'export function formatDate(date: Date): string');
  assert.include(newModuleSource, 'function formatISODate(date: Date): string');
  assert.include(newModuleSource, 'return format(date');
  assert.include(newModuleSource, 'Formats a date to ISO string');
  
  // Should not include validateEmail-related imports since they're shared
  assert.notInclude(newModuleSource, './utils');
  
  console.log('Generated new module source:');
  console.log(newModuleSource);
});

test('Generate new module with mixed exports and internal symbols', () => {
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
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  const newModuleSource = generateNewModuleSource(symbolDefinitions, []);
  
  // publicFunction should remain exported
  assert.include(newModuleSource, 'export function publicFunction()');
  
  // helper should become exported (since it's being moved to new module)
  assert.include(newModuleSource, 'function helper()');
  
  // CONSTANT should be included
  assert.include(newModuleSource, "const CONSTANT = 'value';");
  
  console.log('Generated mixed module source:');
  console.log(newModuleSource);
});

test('Remove symbols from original source', () => {
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

  const sourceFile = createTestSourceFile(source);
  
  // Remove formatDate and formatISODate
  const symbolsToRemove = new Set(['formatDate', 'formatISODate']);
  const modifiedSource = removeSymbolsFromSource(sourceFile, symbolsToRemove);
  
  // Should remove the functions
  assert.notInclude(modifiedSource, 'function formatDate');
  assert.notInclude(modifiedSource, 'function formatISODate');
  
  // Should keep validateEmail
  assert.include(modifiedSource, 'function validateEmail');
  
  // Should keep constants
  assert.include(modifiedSource, 'const API_URL');
  assert.include(modifiedSource, 'const DEBUG');
  
  console.log('Modified source after removing symbols:');
  console.log(modifiedSource);
});

test('Remove unused imports after symbol removal', () => {
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

  const sourceFile = createTestSourceFile(source);
  
  // Simulate removing formatDate
  const removedSymbols = new Set(['formatDate']);
  const onlyUsedByRemoved = new Set(['date-fns:format']); // format is only used by formatDate
  
  const modifiedSource = removeUnusedImports(sourceFile, removedSymbols, onlyUsedByRemoved);
  
  // Should remove date-fns import
  assert.notInclude(modifiedSource, "import { format } from 'date-fns'");
  
  // Should keep ./utils import (used by validateEmail)
  assert.include(modifiedSource, "import { helper, validator } from './utils'");
  
  console.log('Modified source after removing unused imports:');
  console.log(modifiedSource);
});

test('Add import for moved symbols with re-export', () => {
  const source = `
export function validateEmail(email: string): boolean {
  return email.includes('@');
}

const API_URL = 'https://api.example.com';
`;

  const sourceFile = createTestSourceFile(source);
  
  // Add import and re-export for moved symbols
  const movedSymbols = new Set(['formatDate', 'formatISODate']);
  const modifiedSource = addImportForMovedSymbols(sourceFile, movedSymbols, './date-utils', true);
  
  // Should NOT add import when shouldReExport is true - symbols are only re-exported, not used
  assert.notMatch(modifiedSource, /^import.*formatDate/m, 
    'Should not have import statement when only re-exporting');
  
  // Should add re-export  
  assert.include(modifiedSource, 'export { formatDate, formatISODate }');
  
  // Should keep existing code
  assert.include(modifiedSource, 'function validateEmail');
  
  console.log('Modified source after adding re-exports:');
  console.log(modifiedSource);
});

test('Move type that depends on const value with typeof', () => {
  // Reproduces bug where splitting a type like `typeof myConst[number]`
  // doesn't also move the const that the type depends on
  const source = `
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

  const moduleInfo = parseIsolatedSourceCode(source);
  
  // Build dependencies
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  // DerivedFromConst should depend on myConstArray
  const derivedDeps = deps.dependencies.get('DerivedFromConst');
  assert.isDefined(derivedDeps, 'DerivedFromConst should have dependencies tracked');
  assertDefined(derivedDeps, 'derivedDeps should be defined');
  assert.isTrue(derivedDeps.has('myConstArray'), 
    'DerivedFromConst should depend on myConstArray (typeof dependency)');
  
  // When splitting these types, myConstArray must be included
  const symbolsToMove = new Set(['DerivedFromConst', 'UsesImportedType', 'MappedTypeUsingImport']);
  
  // Analyze each symbol to collect all required dependencies
  const allRequired = new Set<string>();
  for (const symbol of symbolsToMove) {
    const analysis = analyzeSplit(deps, symbol);
    for (const req of analysis.requiredDependencies) {
      allRequired.add(req);
    }
  }
  
  // Should detect that myConstArray needs to move
  assert.isTrue(allRequired.has('myConstArray'),
    'myConstArray should be required because DerivedFromConst uses it via typeof');
  
  // Generate new module with all required symbols
  const sourceFile = createTestSourceFile(source);
  const allSymbolsToMove = new Set([...symbolsToMove, ...allRequired]);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbolsToMove);
  
  // Analyze import usage
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, allSymbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);
  
  // Generate new module
  const newModuleSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  // Verify myConstArray is in the new module
  assert.include(newModuleSource, "export const myConstArray = <const>['value1', 'value2'];",
    'myConstArray must be moved to new module');
  
  // Verify DerivedFromConst is in the new module and still references myConstArray
  assert.include(newModuleSource, 'export type DerivedFromConst = typeof myConstArray[number];',
    'DerivedFromConst should reference myConstArray correctly');
  
  // Verify imports are included
  assert.include(newModuleSource, 'import type { ExternalType } from "./external"',
    'ExternalType import should be moved to new module');
  
  // Verify all types are present
  assert.include(newModuleSource, 'export interface UsesImportedType');
  assert.include(newModuleSource, 'export type MappedTypeUsingImport');
  
  console.log('Generated new module with typeof dependency:');
  console.log(newModuleSource);
});

test('Complete split workflow with type/value separation in re-exports', () => {
  // End-to-end test: split types with typeof dependency, then verify
  // that the source file correctly separates type-only and value re-exports
  const source = `
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

  const moduleInfo = parseIsolatedSourceCode(source);
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  const symbolsToMove = new Set(['DerivedFromConst', 'UsesImportedType', 'MappedTypeUsingImport']);
  
  // Collect all required dependencies
  const allRequired = new Set<string>();
  for (const symbol of symbolsToMove) {
    const analysis = analyzeSplit(deps, symbol);
    for (const req of analysis.requiredDependencies) {
      allRequired.add(req);
    }
  }
  
  // Should include myConstArray
  assert.isTrue(allRequired.has('myConstArray'));
  
  const sourceFile = createTestSourceFile(source);
  const allSymbolsToMove = new Set([...symbolsToMove, ...allRequired]);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbolsToMove);
  
  // Generate new module
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, allSymbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);
  const newModuleSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  // Verify new module has all symbols
  assert.include(newModuleSource, 'export const myConstArray');
  assert.include(newModuleSource, 'export type DerivedFromConst');
  assert.include(newModuleSource, 'export interface UsesImportedType');
  assert.include(newModuleSource, 'export type MappedTypeUsingImport');
  
  // Remove symbols from source and add imports/re-exports
  const cleanedSource = removeSymbolsFromSource(sourceFile, allSymbolsToMove);
  const sourceFileForImports = createTestSourceFile(cleanedSource);
  
  // Pass symbolDefinitions so function knows which are types vs values
  const finalSource = addImportForMovedSymbols(
    sourceFileForImports, 
    allSymbolsToMove, 
    './itemDeps', 
    true,
    symbolDefinitions
  );
  
  // Verify source still has Item
  assert.include(finalSource, 'export interface Item');
  
  // Item uses DerivedFromConst, UsesImportedType, and MappedTypeUsingImport,
  // so imports ARE needed for those types even though they're also re-exported
  assert.match(finalSource, /^import type.*DerivedFromConst/m,
    'Should have import for type used in Item');
  assert.match(finalSource, /^import type.*UsesImportedType/m,
    'Should have import for type used in Item');
  assert.match(finalSource, /^import type.*MappedTypeUsingImport/m,
    'Should have import for type used in Item');
  
  // myConstArray was moved as a dependency, check if it needs import
  // Since it's not referenced in the remaining source, no import needed for it
  
  // Verify type-only re-exports
  assert.match(finalSource, /export type \{[^}]*DerivedFromConst[^}]*\}/,
    'DerivedFromConst should use export type');
  assert.match(finalSource, /export type \{[^}]*UsesImportedType[^}]*\}/,
    'UsesImportedType should use export type');
  assert.match(finalSource, /export type \{[^}]*MappedTypeUsingImport[^}]*\}/,
    'MappedTypeUsingImport should use export type');
  
  // Verify value re-export
  assert.match(finalSource, /export \{[^}]*myConstArray[^}]*\}/,
    'myConstArray should use regular export');
  
  console.log('=== Final source with proper type/value separation in re-exports ===');
  console.log(finalSource);
});

test('Mapped type detects dependencies on key types and local types', () => {
  // Bug reproduction: When moving a mapped type like `[K in ExternalSlot]: LocalIcon | null`,
  // TSLOR must detect dependencies on:
  // 1. The key type (ExternalSlot) used in the mapped type
  // 2. Local types referenced in the value type (LocalIcon)
  const source = `
import type { ExternalDep1, ExternalDep2, ExternalSlot } from './external';

// Local type that will be referenced by moved type
export interface LocalIcon {
  icon: string;
  tooltip?: string;
}

// Type using mapped type with external dependency (should move, needs ExternalSlot)
export type IconMap = {
  [K in ExternalSlot]: LocalIcon | null;
};

// Type using external dependency (should move, needs ExternalDep1)
export interface Request {
  executedBy: string;
  params: ExternalDep1;
}

// Type using another external dependency (should move, needs ExternalDep2)
export interface Entry {
  value: ExternalDep2;
}

// Main type to keep
export interface Data {
  id: string;
  name: string;
}
`;

  const moduleInfo = parseIsolatedSourceCode(source);
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  const symbolsToMove = new Set(['IconMap', 'Request', 'Entry']);
  
  // Collect all required dependencies
  const allRequired = new Set<string>();
  for (const symbol of symbolsToMove) {
    const analysis = analyzeSplit(deps, symbol);
    for (const req of analysis.requiredDependencies) {
      allRequired.add(req);
    }
  }
  
  // CRITICAL: LocalIcon must be detected as a dependency of IconMap
  assert.isTrue(allRequired.has('LocalIcon'),
    'LocalIcon should be required because IconMap references it in the mapped type value');
  
  // Generate new module with all required symbols
  const sourceFile = createTestSourceFile(source);
  const allSymbolsToMove = new Set([...symbolsToMove, ...allRequired]);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbolsToMove);
  
  // Verify LocalIcon was included in symbols to move
  assert.isTrue(allSymbolsToMove.has('LocalIcon'),
    'LocalIcon must be included in symbols to move');
  
  // Analyze import usage
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, allSymbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);
  
  // Generate new module
  const newModuleSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  // Verify LocalIcon is in the new module
  assert.include(newModuleSource, 'export interface LocalIcon',
    'LocalIcon must be moved to new module');
  
  // Verify IconMap is in the new module
  assert.include(newModuleSource, 'export type IconMap',
    'IconMap should be in new module');
  
  // Verify ExternalSlot is imported (needed by mapped type key)
  assert.include(newModuleSource, 'ExternalSlot',
    'ExternalSlot import should be in new module for mapped type key');
  
  // Verify ExternalDep1 and ExternalDep2 are imported
  assert.include(newModuleSource, 'ExternalDep1',
    'ExternalDep1 import should be in new module');
  assert.include(newModuleSource, 'ExternalDep2',
    'ExternalDep2 import should be in new module');
  
  console.log('Generated new module with mapped type dependencies:');
  console.log(newModuleSource);
});

test('Move types with transitive type reference dependencies', () => {
  const source = `
// Base type that ItemCustomIconUpdateDto depends on
export type ItemCustomIconsDto = Record<string, string>;

// Another base type
export interface ItemCustomIconBlendedDto {
  iconUrl: string;
}

// Type to move - depends on ItemCustomIconsDto
export type ItemCustomIconUpdateDto = {
  customIcons: ItemCustomIconsDto
};

// Type to move - depends on ItemCustomIconBlendedDto
export type ItemCustomIconsBlendedDto = (ItemCustomIconBlendedDto | null)[];
`;

  const moduleInfo = parseIsolatedSourceCode(source);
  
  // Build dependencies
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  // ItemCustomIconUpdateDto should depend on ItemCustomIconsDto
  const updateDtoDeps = deps.dependencies.get('ItemCustomIconUpdateDto');
  assert.isDefined(updateDtoDeps, 'ItemCustomIconUpdateDto should have dependencies tracked');
  assertDefined(updateDtoDeps, 'updateDtoDeps should be defined');
  assert.isTrue(updateDtoDeps.has('ItemCustomIconsDto'), 
    'ItemCustomIconUpdateDto should depend on ItemCustomIconsDto');
  
  // ItemCustomIconsBlendedDto should depend on ItemCustomIconBlendedDto
  const blendedDtoDeps = deps.dependencies.get('ItemCustomIconsBlendedDto');
  assert.isDefined(blendedDtoDeps, 'ItemCustomIconsBlendedDto should have dependencies tracked');
  assertDefined(blendedDtoDeps, 'blendedDtoDeps should be defined');
  assert.isTrue(blendedDtoDeps.has('ItemCustomIconBlendedDto'), 
    'ItemCustomIconsBlendedDto should depend on ItemCustomIconBlendedDto');
  
  // When splitting these types, their dependencies must be included
  const symbolsToMove = new Set(['ItemCustomIconUpdateDto', 'ItemCustomIconsBlendedDto']);
  
  // Analyze each symbol to collect all required dependencies
  const allRequired = new Set<string>();
  for (const symbol of symbolsToMove) {
    const analysis = analyzeSplit(deps, symbol);
    for (const req of analysis.requiredDependencies) {
      allRequired.add(req);
    }
  }
  
  // Should detect that both base types need to move
  assert.isTrue(allRequired.has('ItemCustomIconsDto'),
    'ItemCustomIconsDto should be required because ItemCustomIconUpdateDto references it');
  assert.isTrue(allRequired.has('ItemCustomIconBlendedDto'),
    'ItemCustomIconBlendedDto should be required because ItemCustomIconsBlendedDto references it');
  
  // Generate new module with all required symbols
  const sourceFile = createTestSourceFile(source);
  const allSymbolsToMove = new Set([...symbolsToMove, ...allRequired]);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbolsToMove);
  
  // Analyze import usage
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, allSymbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);
  
  // Generate new module
  const newModuleSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  // Verify all four types are in the new module
  assert.include(newModuleSource, "export type ItemCustomIconsDto = Record<string, string>;",
    'ItemCustomIconsDto must be moved to new module');
  assert.include(newModuleSource, 'export interface ItemCustomIconBlendedDto',
    'ItemCustomIconBlendedDto must be moved to new module');
  assert.include(newModuleSource, 'export type ItemCustomIconUpdateDto',
    'ItemCustomIconUpdateDto should be in new module');
  assert.include(newModuleSource, 'export type ItemCustomIconsBlendedDto',
    'ItemCustomIconsBlendedDto should be in new module');
  
  console.log('Generated new module with transitive type dependencies:');
  console.log(newModuleSource);
});

test('Re-exports should not create unused imports', () => {
  // Bug reproduction: When symbols are moved and re-exported, TSLOR was adding
  // unnecessary import statements that are never used in the file body, only re-exported.
  // This causes TypeScript errors with noUnusedLocals enabled.
  const source = `
// Original file with types to be split out
export interface ItemDto {
  id: string;
}

export const CONFIG = ['a', 'b'] as const;
export type ConfigType = typeof CONFIG[number];

export interface CustomData {
  value: string;
}
`;

  const moduleInfo = parseIsolatedSourceCode(source);
  const deps = buildIntraModuleDependencies(moduleInfo);
  
  const symbolsToMove = new Set(['CustomData']);
  const analysis = analyzeSplit(deps, 'CustomData');
  
  // CustomData has no internal dependencies
  assert.equal(analysis.requiredDependencies.size, 0);
  
  const sourceFile = createTestSourceFile(source);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  // Generate new module
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);
  const newModuleSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  // Verify new module has the symbol
  assert.include(newModuleSource, 'export interface CustomData');
  
  // Remove symbols from source and add imports/re-exports
  const cleanedSource = removeSymbolsFromSource(sourceFile, symbolsToMove);
  const sourceFileForImports = createTestSourceFile(cleanedSource);
  
  const finalSource = addImportForMovedSymbols(
    sourceFileForImports, 
    symbolsToMove, 
    './target', 
    true,
    symbolDefinitions
  );
  
  // Verify source still has other symbols
  assert.include(finalSource, 'export interface ItemDto');
  assert.include(finalSource, 'export const CONFIG');
  
  // Critical: verify there are NO import statements for CustomData
  // Only re-export statements should exist
  assert.notMatch(finalSource, /^import.*CustomData/m,
    'Should not have import statement for re-exported symbol');
  
  // Verify re-export exists
  assert.match(finalSource, /export type \{[^}]*CustomData[^}]*\}/,
    'Should have type re-export for CustomData');
  
  console.log('=== Final source without unused imports ===');
  console.log(finalSource);
});