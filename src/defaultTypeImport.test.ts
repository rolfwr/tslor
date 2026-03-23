/**
 * Test for type-only default import handling bug
 * 
 * This test reproduces the issue where tslor fails to properly handle
 * type-only default imports when splitting a module.
 * 
 * Bug: When splitting MyInterface which has a property referencing a 
 * type-only default import (import type ExternalType from './external'),
 * the split operation should preserve the type-only default import syntax
 * in the new module, but currently it may generate incorrect import syntax.
 */

import { assert, test } from 'vitest';
import { Project, SourceFile } from 'ts-morph';
import { parseIsolatedSourceCode } from './parseIsolatedSourceCode';
import { analyzeImportUsageFromStaticInfo, parseModule } from './indexing';
import {
  buildIntraModuleDependencies,
  analyzeSplit,
  extractSymbolDefinitions,
  findImportsOnlyUsedBySymbols,
  computeRequiredImports,
  generateNewModuleSource,
  removeSymbolsFromSource,
  removeUnusedImports,
  addImportForMovedSymbols
} from './splitModule';

/**
 * Create a source file from source code for testing
 */
function createTestSourceFile(project: Project, filename: string, sourceCode: string): SourceFile {
  return project.createSourceFile(filename, sourceCode);
}

/**
 * Test: Type-only default imports should be preserved
 * 
 * This is the minimal reproduction from test-minimal/ and test-expected/
 */
test('Default type import: preserve type-only default import syntax', () => {
  // Input code from test-minimal/src/source.ts
  const sourceInput = `// Source file with type-only default imports that will be moved
import type ExternalType from './external';

export interface MyInterface {
    field: ExternalType;
}

export const helperFunc = () => 'helper';
`;

  // External module that provides the default export
  const externalInput = `// External module providing a default export
export default interface ExternalType {
    prop: string;
}
`;

  // Expected target.ts content from test-expected/
  const expectedTarget = `// Target file with correct default import syntax
import type ExternalType from './external';

export interface MyInterface {
    field: ExternalType;
}
`;

  // Expected source.ts content after split from test-expected/
  const expectedSource = `// Source file with type-only default imports that will be moved
import { MyInterface } from './target';

export const helperFunc = () => 'helper';

export { MyInterface } from "./target";
`;

  // Create project with both files
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, 'source.ts', sourceInput);
  const externalFile = createTestSourceFile(project, 'external.ts', externalInput);

  // Verify no initial type errors
  const initialDiagnostics = project.getPreEmitDiagnostics();
  if (initialDiagnostics.length > 0) {
    console.error('Initial type errors:');
    for (const diag of initialDiagnostics) {
      console.error(`  ${diag.getSourceFile()?.getFilePath()}: ${diag.getMessageText()}`);
    }
  }
  assert.equal(initialDiagnostics.length, 0, 'Should have no type errors initially');

  // Parse the source
  const moduleInfo = parseIsolatedSourceCode(sourceInput);
  const deps = buildIntraModuleDependencies(moduleInfo);

  // Split MyInterface
  const symbolsToMove = new Set(['MyInterface']);
  const analysis = analyzeSplit(deps, 'MyInterface');

  if (!analysis.canSplit) {
    throw new Error(`Cannot split MyInterface: ${analysis.circularDependencies.join(', ')}`);
  }

  // Add transitive dependencies
  for (const dep of analysis.requiredDependencies) {
    symbolsToMove.add(dep);
  }

  console.log('Symbols to move:', Array.from(symbolsToMove).sort());

  // Generate the split using the REAL code path from runProposeSplit
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  // THIS IS THE KEY: Use the same code path as runProposeSplit
  const staticModuleInfo = parseModule(sourceFile);
  const importUsages = analyzeImportUsageFromStaticInfo(staticModuleInfo);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);

  // Generate target module
  const actualTarget = generateNewModuleSource(symbolDefinitions, requiredImports);

  console.log('=== ACTUAL TARGET ===');
  console.log(actualTarget);
  console.log('=== EXPECTED TARGET ===');
  console.log(expectedTarget);

  // KEY ASSERTION: Target should have type-only default import
  assert.include(
    actualTarget,
    'import type ExternalType from',
    'Target should have type-only default import for ExternalType'
  );

  assert.include(
    actualTarget,
    'export interface MyInterface',
    'Target should have MyInterface'
  );

  assert.include(
    actualTarget,
    'field: ExternalType',
    'MyInterface should reference ExternalType'
  );

  // Generate modified source module
  let actualSource = removeSymbolsFromSource(sourceFile, symbolsToMove);

  const sourceFileAfterRemoval = project.createSourceFile(`temp-after-removal-${Date.now()}.ts`, actualSource);
  actualSource = removeUnusedImports(sourceFileAfterRemoval, symbolsToMove, onlyUsedByTarget);

  const sourceFileAfterCleanup = project.createSourceFile(`temp-after-cleanup-${Date.now()}.ts`, actualSource);
  
  // Only re-export symbols that were actually moved (have definitions), not external dependencies
  const actuallyMovedSymbols = new Set(symbolDefinitions.map(def => def.name));
  actualSource = addImportForMovedSymbols(sourceFileAfterCleanup, actuallyMovedSymbols, './target', true);

  console.log('=== ACTUAL SOURCE ===');
  console.log(actualSource);
  console.log('=== EXPECTED SOURCE ===');
  console.log(expectedSource);

  // Source should keep helperFunc and re-export MyInterface
  assert.include(actualSource, 'helperFunc', 'Source should keep helperFunc');
  assert.include(actualSource, 'from "./target"', 'Source should import from target');
  assert.include(actualSource, 'export { MyInterface }', 'Source should re-export MyInterface');

  // Source should NOT have MyInterface definition
  assert.notInclude(actualSource, 'interface MyInterface {', 'Source should not have MyInterface definition');

  // Source should NOT have ExternalType import (since MyInterface moved)
  assert.notInclude(actualSource, 'ExternalType', 'Source should not import ExternalType anymore');

  // Now verify the split code compiles without errors
  const targetFile = project.createSourceFile('target.ts', actualTarget);
  sourceFile.replaceWithText(actualSource);

  const finalDiagnostics = project.getPreEmitDiagnostics();

  if (finalDiagnostics.length > 0) {
    console.error('Type errors after split:');
    for (const diag of finalDiagnostics) {
      const file = diag.getSourceFile();
      const filePath = file?.getFilePath() || 'unknown';
      const lineAndChar = file?.getLineAndColumnAtPos(diag.getStart() || 0);
      console.error(`  ${filePath}:${lineAndChar?.line}:${lineAndChar?.column}: ${diag.getMessageText()}`);
    }
  }

  assert.equal(
    finalDiagnostics.length,
    0,
    'Should have no type errors after split - type-only default import should work correctly'
  );

  console.log('✅ Type-only default import preserved correctly!');
});

/**
 * Test: Verify that regular (non-type-only) default imports also work
 */
test('Default type import: regular default imports should work', () => {
  const sourceInput = `import ExternalValue from './external';

export const myConst = ExternalValue;

export const helperFunc = () => 'helper';
`;

  const externalInput = `const value = 42;
export default value;
`;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = createTestSourceFile(project, 'source.ts', sourceInput);
  const externalFile = createTestSourceFile(project, 'external.ts', externalInput);

  // Verify no initial type errors
  const initialDiagnostics = project.getPreEmitDiagnostics();
  assert.equal(initialDiagnostics.length, 0, 'Should have no type errors initially');

  // Parse and split
  const moduleInfo = parseIsolatedSourceCode(sourceInput);
  const deps = buildIntraModuleDependencies(moduleInfo);
  const symbolsToMove = new Set(['myConst']);
  const analysis = analyzeSplit(deps, 'myConst');

  for (const dep of analysis.requiredDependencies) {
    symbolsToMove.add(dep);
  }

  // Generate split using the REAL code path
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  const staticModuleInfo = parseModule(sourceFile);
  const importUsages = analyzeImportUsageFromStaticInfo(staticModuleInfo);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);

  const actualTarget = generateNewModuleSource(symbolDefinitions, requiredImports);

  console.log('=== ACTUAL TARGET (regular import) ===');
  console.log(actualTarget);

  // Should have regular default import (no 'type' keyword)
  assert.include(actualTarget, 'import ExternalValue from', 'Target should have default import');
  assert.notInclude(actualTarget, 'import type ExternalValue', 'Should NOT be type-only since value is used at runtime');

  let actualSource = removeSymbolsFromSource(sourceFile, symbolsToMove);
  const sourceFileAfterRemoval = project.createSourceFile(`temp-after-removal-${Date.now()}.ts`, actualSource);
  actualSource = removeUnusedImports(sourceFileAfterRemoval, symbolsToMove, onlyUsedByTarget);
  const sourceFileAfterCleanup = project.createSourceFile(`temp-after-cleanup-${Date.now()}.ts`, actualSource);
  
  // Only re-export symbols that were actually moved (have definitions), not external dependencies
  const actuallyMovedSymbols = new Set(symbolDefinitions.map(def => def.name));
  actualSource = addImportForMovedSymbols(sourceFileAfterCleanup, actuallyMovedSymbols, './target', true);

  // Verify compilation
  const targetFile = project.createSourceFile('target.ts', actualTarget);
  sourceFile.replaceWithText(actualSource);

  const finalDiagnostics = project.getPreEmitDiagnostics();
  if (finalDiagnostics.length > 0) {
    console.error('Type errors:');
    for (const diag of finalDiagnostics) {
      console.error(`  ${diag.getSourceFile()?.getFilePath()}: ${diag.getMessageText()}`);
    }
  }

  assert.equal(finalDiagnostics.length, 0, 'Should compile correctly with regular default import');

  console.log('✅ Regular default import handled correctly!');
});
