import { test, assert } from 'vitest';
import { Project } from 'ts-morph';
import { parseModule, analyzeImportUsageFromStaticInfo } from './indexing';
import {
  buildIntraModuleDependencies,
  analyzeSplit,
  extractSymbolDefinitions,
  findImportsOnlyUsedBySymbols,
  computeRequiredImports,
  generateNewModuleSource,
  removeSymbolsFromSource,
  removeUnusedImports,
  addImportForMovedSymbols,
} from './splitModule';
import { relative, dirname } from 'path';

/**
 * Helper to create a test source file in ts-morph's in-memory file system
 */
function createTestSourceFile(project: Project, filename: string, content: string) {
  return project.createSourceFile(filename, content);
}

/**
 * Core split logic that operates entirely in memory
 */
function performSplitInMemory(
  project: Project,
  sourceFile: any,
  targetPath: string,
  symbolsToMove: string[]
): { sourceContent: string; targetContent: string; errors: string[] } {
  const errors: string[] = [];
  
  // Parse and analyze source module
  const staticModuleInfo = parseModule(sourceFile);
  
  // Validate symbols exist
  for (const symbol of symbolsToMove) {
    if (!staticModuleInfo.exports.has(symbol)) {
      errors.push(`Symbol '${symbol}' is not exported`);
    }
  }
  
  if (errors.length > 0) {
    return { sourceContent: '', targetContent: '', errors };
  }
  
  // Build dependency graph
  const dependencies = buildIntraModuleDependencies(staticModuleInfo);
  
  // Analyze each symbol for splitting
  const allSymbolsToMove = new Set<string>(symbolsToMove);
  for (const symbol of symbolsToMove) {
    const analysis = analyzeSplit(dependencies, symbol);
    
    if (!analysis.canSplit) {
      errors.push(`Cannot split '${symbol}': circular dependencies with ${analysis.circularDependencies.join(', ')}`);
      continue;
    }
    
    // Add transitive dependencies
    for (const dep of analysis.requiredDependencies) {
      allSymbolsToMove.add(dep);
    }
  }
  
  if (errors.length > 0) {
    return { sourceContent: '', targetContent: '', errors };
  }
  
  // Check not moving all symbols
  const exportedSymbolsToMove = Array.from(allSymbolsToMove).filter(s => dependencies.exports.has(s));
  if (exportedSymbolsToMove.length === dependencies.exports.size && dependencies.exports.size > 0) {
    errors.push('Cannot move all exported symbols');
    return { sourceContent: '', targetContent: '', errors };
  }
  
  // Extract symbol definitions
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbolsToMove);
  
  // Analyze import usage
  const importUsages = analyzeImportUsageFromStaticInfo(staticModuleInfo);
  const onlyUsedByMovedSymbols = findImportsOnlyUsedBySymbols(importUsages, allSymbolsToMove);
  
  // Compute required imports for target
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByMovedSymbols);
  
  // Generate target module
  const targetContent = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  // Update source: remove moved symbols
  const updatedSource = removeSymbolsFromSource(sourceFile, allSymbolsToMove);
  
  // Create temporary source file to continue processing
  const tempSource = project.createSourceFile('__temp_source.ts', updatedSource, { overwrite: true });
  
  // Remove unused imports
  const cleanedSource = removeUnusedImports(tempSource, allSymbolsToMove, onlyUsedByMovedSymbols);
  
  // Add imports for re-exports
  const symbolsToReExport = new Set(Array.from(allSymbolsToMove).filter(s => dependencies.exports.has(s)));
  
  if (symbolsToReExport.size > 0) {
    const tempSource2 = project.createSourceFile('__temp_source2.ts', cleanedSource, { overwrite: true });
    const sourcePath = sourceFile.getFilePath();
    const relativePath = getRelativeImportPath(sourcePath, targetPath);
    const finalSource = addImportForMovedSymbols(tempSource2, symbolsToReExport, relativePath, true, symbolDefinitions);
    
    return { sourceContent: finalSource, targetContent, errors: [] };
  }
  
  return { sourceContent: cleanedSource, targetContent, errors: [] };
}

function getRelativeImportPath(sourcePath: string, targetPath: string): string {
  const relativePath = relative(dirname(sourcePath), targetPath);
  let modulePath = relativePath.replace(/\.ts$/, '');
  if (!modulePath.startsWith('.')) {
    modulePath = './' + modulePath;
  }
  return modulePath;
}

test('Error: non-existent symbols should be rejected', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, '/test/source.ts', `
export function hello(): string {
  return 'world';
}

export function goodbye(): string {
  return 'farewell';
}
`);

  const result = performSplitInMemory(project, sourceFile, '/test/target.ts', ['nonExistentFunction']);
  
  assert.isTrue(result.errors.length > 0);
  assert.include(result.errors[0], 'nonExistentFunction');
  assert.include(result.errors[0], 'not exported');
});

test('Error: moving all symbols should be rejected', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, '/test/source.ts', `
export function hello(): string {
  return 'world';
}

export function goodbye(): string {
  return 'farewell';
}
`);

  const result = performSplitInMemory(project, sourceFile, '/test/target.ts', ['hello', 'goodbye']);
  
  assert.isTrue(result.errors.length > 0);
  assert.include(result.errors[0], 'Cannot move all');
});

test('Success: simple function split', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, '/test/source.ts', `
export function hello(): string {
  return 'world';
}

export function goodbye(): string {
  return 'farewell';
}

const INTERNAL_CONSTANT = 'secret';
`);

  const result = performSplitInMemory(project, sourceFile, '/test/target.ts', ['hello']);
  
  assert.equal(result.errors.length, 0, 'Should have no errors');
  
  // Check target content
  assert.include(result.targetContent, 'export function hello()');
  assert.include(result.targetContent, 'return \'world\'');
  
  // Check source content
  assert.include(result.sourceContent, 'export function goodbye()');
  assert.include(result.sourceContent, 'INTERNAL_CONSTANT');
  assert.notInclude(result.sourceContent, 'function hello()');
  // Should only have re-export, not import
  assert.notMatch(result.sourceContent, /^import.*hello/m, 'Should not have import when only re-exporting');
  assert.include(result.sourceContent, 'export { hello }');
});

test('Success: function with internal dependencies', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, '/test/source.ts', `
export function formatDate(date: Date): string {
  return formatISODate(date);
}

function formatISODate(date: Date): string {
  return date.toISOString();
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}
`);

  const result = performSplitInMemory(project, sourceFile, '/test/target.ts', ['formatDate']);
  
  assert.equal(result.errors.length, 0);
  
  // Target should have both functions
  assert.include(result.targetContent, 'export function formatDate(');
  assert.include(result.targetContent, 'function formatISODate(');
  
  // Source should not have either function
  assert.notInclude(result.sourceContent, 'function formatDate');
  assert.notInclude(result.sourceContent, 'function formatISODate');
  assert.include(result.sourceContent, 'validateEmail');
  
  // Should re-export only formatDate
  assert.include(result.sourceContent, 'export { formatDate }');
  assert.notInclude(result.sourceContent, 'formatISODate');
});

test('Success: function with external imports', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, '/test/source.ts', `
import { format } from 'date-fns';
import { helper, validator } from './utils';

export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function validateEmail(email: string): boolean {
  return validator(email) && helper(email);
}

export function processData(data: string): string {
  return data.toUpperCase();
}
`);

  const result = performSplitInMemory(project, sourceFile, '/test/target.ts', ['formatDate']);
  
  assert.equal(result.errors.length, 0);
  
  // Target should have date-fns import
  assert.include(result.targetContent, 'import { format } from "date-fns"');
  assert.include(result.targetContent, 'export function formatDate(');
  
  // Source should not have date-fns
  assert.notInclude(result.sourceContent, 'date-fns');
  assert.include(result.sourceContent, 'from \'./utils\'');
  assert.include(result.sourceContent, 'validateEmail');
  assert.include(result.sourceContent, 'processData');
});

test('Edge case: circular dependencies', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, '/test/source.ts', `
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
`);

  const result = performSplitInMemory(project, sourceFile, '/test/target.ts', ['funcA']);
  
  assert.isTrue(result.errors.length > 0);
  assert.include(result.errors[0], 'circular dependencies');
});

test('Success: TypeScript type dependencies', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, '/test/source.ts', `
export interface User {
  name: string;
  email: string;
}

export function formatUser(user: User): string {
  return user.name + ' - ' + user.email;
}

const INTERNAL_CONFIG = {
  maxLength: 100
};

export function processUser(user: User): User {
  if (user.name.length > INTERNAL_CONFIG.maxLength) {
    throw new Error('Name too long');
  }
  return user;
}

export type UserValidator = (user: User) => boolean;
`);

  const result = performSplitInMemory(project, sourceFile, '/test/target.ts', ['formatUser']);
  
  assert.equal(result.errors.length, 0);
  
  // Target should have User interface
  assert.include(result.targetContent, 'export interface User');
  assert.include(result.targetContent, 'export function formatUser(');
  
  // Source should not have User interface
  assert.notInclude(result.sourceContent, 'interface User');
  assert.include(result.sourceContent, 'export function processUser(');
  assert.include(result.sourceContent, 'export type UserValidator');
  
  // User is still used in source (by processUser and UserValidator), so it needs import
  assert.include(result.sourceContent, 'import type { User }');
  // formatUser is only re-exported, so NO import for it
  assert.notMatch(result.sourceContent, /^import.*formatUser/m, 'Should not import re-exported symbol');
  // But should have re-exports for both
  assert.include(result.sourceContent, 'export type { User }');
  assert.include(result.sourceContent, 'export { formatUser }');
});
