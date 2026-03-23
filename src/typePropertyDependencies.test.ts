/**
 * Test for type property dependency detection bug
 * 
 * This test reproduces the issue where tslor fails to detect that when
 * splitting an interface, it must also move type dependencies referenced
 * in the interface's property declarations.
 * 
 * Bug: When Item interface has a property `virtualClipInfo?: VirtualClip`,
 * the split operation should move VirtualClip along with Item, but currently
 * it does not, causing type errors.
 */

import { assert, test } from 'vitest';
import { Project, SourceFile } from 'ts-morph';
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
  analyzeImportUsageBySymbol
} from './splitModule';
import { parseIsolatedSourceCode } from './parseIsolatedSourceCode';

/**
 * Create a source file from source code for testing
 */
function createTestSourceFile(sourceCode: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('test.ts', sourceCode);
}

/**
 * Test: Type property references should be detected as dependencies
 * 
 * This is the minimal reproduction of the VirtualClip issue from real codebase.
 */
test('Type property dependencies: interface property type references', () => {
  // Input code from test-minimal/
  const inputSource = `
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

  // Expected itemType.ts content from test-expected/
  const expectedTargetSource = `export interface DerivedClip {
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
`;

  // Expected item.ts content after split
  const expectedSourceSource = `export interface OtherType {
  value: string;
}

export { Item, PendingArchiveRequest, PendingTransferRequest, VirtualClip, DerivedClip } from "./itemType";
`;

  // Parse the source
  const moduleInfo = parseIsolatedSourceCode(inputSource);
  const deps = buildIntraModuleDependencies(moduleInfo);

  // When splitting Item, PendingArchiveRequest, PendingTransferRequest
  const requestedSymbols = ['Item', 'PendingArchiveRequest', 'PendingTransferRequest'];

  // Analyze what needs to be moved
  const allSymbolsToMove = new Set<string>();
  const splitAnalyses: Array<{ symbol: string; analysis: any }> = [];

  for (const symbol of requestedSymbols) {
    const analysis = analyzeSplit(deps, symbol);
    splitAnalyses.push({ symbol, analysis });

    if (!analysis.canSplit) {
      throw new Error(`Cannot split ${symbol}: ${analysis.circularDependencies.join(', ')}`);
    }

    // Add the symbol itself
    allSymbolsToMove.add(symbol);

    // Add its transitive dependencies
    for (const dep of analysis.requiredDependencies) {
      allSymbolsToMove.add(dep);
    }
  }

  // KEY ASSERTION: VirtualClip and DerivedClip should be detected as dependencies
  console.log('Symbols to move:', Array.from(allSymbolsToMove).sort());
  
  assert.isTrue(
    allSymbolsToMove.has('VirtualClip'),
    'VirtualClip should be detected as a dependency of Item (referenced in virtualClipInfo property)'
  );

  assert.isTrue(
    allSymbolsToMove.has('DerivedClip'),
    'DerivedClip should be detected as a transitive dependency (VirtualClip extends DerivedClip)'
  );

  // Should move exactly 5 symbols
  const expectedSymbols = new Set(['Item', 'PendingArchiveRequest', 'PendingTransferRequest', 'VirtualClip', 'DerivedClip']);
  assert.deepEqual(
    allSymbolsToMove,
    expectedSymbols,
    `Should move exactly these 5 symbols: ${Array.from(expectedSymbols).join(', ')}`
  );

  // Verify we're not moving everything
  assert.isFalse(
    allSymbolsToMove.has('OtherType'),
    'OtherType should NOT be moved'
  );

  // Generate the actual split
  const sourceFile = createTestSourceFile(inputSource);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, allSymbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);

  // Generate target module
  const actualTargetSource = generateNewModuleSource(symbolDefinitions, requiredImports);

  // Generate modified source module - chain transformations correctly
  const project = sourceFile.getProject();
  let actualSourceSource = removeSymbolsFromSource(sourceFile, allSymbolsToMove);
  
  // Create intermediate source file for next transformation
  const sourceFileAfterRemoval = project.createSourceFile(`temp-after-removal-${Date.now()}.ts`, actualSourceSource);
  actualSourceSource = removeUnusedImports(sourceFileAfterRemoval, allSymbolsToMove, onlyUsedByTarget);
  
  // Create intermediate source file for final transformation
  const sourceFileAfterCleanup = project.createSourceFile(`temp-after-cleanup-${Date.now()}.ts`, actualSourceSource);
  actualSourceSource = addImportForMovedSymbols(sourceFileAfterCleanup, allSymbolsToMove, './itemType', true);

  // Verify target contains all moved symbols
  assert.include(actualTargetSource, 'export interface DerivedClip', 'Target should have DerivedClip');
  assert.include(actualTargetSource, 'export interface VirtualClip', 'Target should have VirtualClip');
  assert.include(actualTargetSource, 'export interface Item', 'Target should have Item');
  assert.include(actualTargetSource, 'virtualClipInfo?: VirtualClip', 'Item should reference VirtualClip');

  // Verify source has OtherType and re-exports
  assert.include(actualSourceSource, 'export interface OtherType', 'Source should keep OtherType');
  assert.include(actualSourceSource, 'from "./itemType"', 'Source should import from itemType');
  assert.include(actualSourceSource, 'export {', 'Source should re-export moved symbols');
  assert.include(actualSourceSource, 'VirtualClip', 'Source should re-export VirtualClip');
  assert.include(actualSourceSource, 'DerivedClip', 'Source should re-export DerivedClip');

  // Verify source doesn't have moved symbols
  assert.notInclude(actualSourceSource, 'interface VirtualClip', 'Source should not have VirtualClip definition');
  assert.notInclude(actualSourceSource, 'interface Item {', 'Source should not have Item definition');

  console.log('✅ Type property dependency detection working correctly!');
});

/**
 * Test: Verify consumer code compatibility after split
 * 
 * This ensures that code importing from the original module still works
 * after the split due to re-exports.
 */
test('Type property dependencies: consumer code remains compatible', () => {
  const itemSource = `
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

  const consumerSource = `
import { Item, VirtualClip } from './item';

export function getVirtualClip(item: Item): VirtualClip | undefined {
  return item.virtualClipInfo;
}

export function createItem(): Item {
  return {
    id: "test",
    virtualClipInfo: {
      type: "derived",
      masterClipId: "master123",
      inPoint: 0,
      outPoint: 100
    }
  };
}
`;

  // Create project with both files
  const project = new Project({ useInMemoryFileSystem: true });
  const itemFile = project.createSourceFile('item.ts', itemSource);
  const consumerFile = project.createSourceFile('consumer.ts', consumerSource);

  // Verify no initial type errors
  const initialDiagnostics = project.getPreEmitDiagnostics();
  assert.equal(initialDiagnostics.length, 0, 'Should have no type errors initially');

  // Perform the split (simulate what tslor does)
  const moduleInfo = parseIsolatedSourceCode(itemSource);
  const deps = buildIntraModuleDependencies(moduleInfo);

  // Detect all symbols to move (including type dependencies)
  const requestedSymbols = ['Item', 'PendingArchiveRequest', 'PendingTransferRequest'];
  const allSymbolsToMove = new Set<string>();

  for (const symbol of requestedSymbols) {
    const analysis = analyzeSplit(deps, symbol);
    allSymbolsToMove.add(symbol);
    for (const dep of analysis.requiredDependencies) {
      allSymbolsToMove.add(dep);
    }
  }

  // Generate new files
  const symbolDefinitions = extractSymbolDefinitions(itemFile, allSymbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(itemFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, allSymbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);

  const targetSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  let modifiedItemSource = removeSymbolsFromSource(itemFile, allSymbolsToMove);
  
  // Chain transformations correctly - create intermediate source files
  const itemFileAfterRemoval = project.createSourceFile(`temp-after-removal-${Date.now()}.ts`, modifiedItemSource);
  modifiedItemSource = removeUnusedImports(itemFileAfterRemoval, allSymbolsToMove, onlyUsedByTarget);
  
  const itemFileAfterCleanup = project.createSourceFile(`temp-after-cleanup-${Date.now()}.ts`, modifiedItemSource);
  modifiedItemSource = addImportForMovedSymbols(itemFileAfterCleanup, allSymbolsToMove, './itemType', true);

  // Update the project with split results
  project.createSourceFile('itemType.ts', targetSource);
  itemFile.replaceWithText(modifiedItemSource);

  // Verify consumer still has no type errors after split
  const finalDiagnostics = project.getPreEmitDiagnostics();
  
  if (finalDiagnostics.length > 0) {
    console.error('Type errors after split:');
    for (const diag of finalDiagnostics) {
      console.error(`  ${diag.getSourceFile()?.getFilePath()}: ${diag.getMessageText()}`);
    }
  }

  assert.equal(
    finalDiagnostics.length,
    0,
    'Should have no type errors after split - consumer code should work via re-exports'
  );

  console.log('✅ Consumer code remains compatible after split!');
});

/**
 * Test: Complex type dependency chains
 * 
 * Tests a more complex scenario with deeper type dependency chains.
 */
test('Type property dependencies: complex nested type references', () => {
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

  const moduleInfo = parseIsolatedSourceCode(source);
  const deps = buildIntraModuleDependencies(moduleInfo);

  // Split ComplexItem
  const analysis = analyzeSplit(deps, 'ComplexItem');
  
  const allSymbolsToMove = new Set(['ComplexItem']);
  for (const dep of analysis.requiredDependencies) {
    allSymbolsToMove.add(dep);
  }

  // Should detect the full dependency chain
  console.log('Moving ComplexItem requires:', Array.from(allSymbolsToMove).sort());

  assert.isTrue(allSymbolsToMove.has('ComplexItem'), 'Should move ComplexItem');
  assert.isTrue(allSymbolsToMove.has('MiddleType'), 'Should move MiddleType (referenced by ComplexItem.info)');
  assert.isTrue(allSymbolsToMove.has('BaseType'), 'Should move BaseType (extended by MiddleType)');
  assert.isTrue(allSymbolsToMove.has('NestedData'), 'Should move NestedData (referenced by MiddleType.data)');
  assert.isTrue(allSymbolsToMove.has('Metadata'), 'Should move Metadata (referenced by NestedData.metadata)');
  
  assert.isFalse(allSymbolsToMove.has('UnrelatedType'), 'Should NOT move UnrelatedType');

  console.log('✅ Complex nested type dependencies detected correctly!');
});

/**
 * Test: Type-only default imports should be preserved correctly
 * 
 * This test reproduces the issue from test-minimal where a type-only
 * default import needs to be moved along with the dependent interface.
 */
test('Type property dependencies: type-only default imports', () => {
  // Input from test-minimal/src/source.ts
  const sourceInput = `// Source file with type-only default imports that will be moved
import type ExternalType from './external';

export interface MyInterface {
    field: ExternalType;
}

export const helperFunc = () => 'helper';
`;

  // The external module
  const externalInput = `// External module providing a default export
export default interface ExternalType {
    prop: string;
}
`;

  // Expected source after split
  const expectedSource = `// Source file with type-only default imports that will be moved
import { MyInterface } from './target';

export const helperFunc = () => 'helper';

export { MyInterface } from "./target";
`;

  // Expected target after split
  const expectedTarget = `// Target file with correct default import syntax
import type ExternalType from './external';

export interface MyInterface {
    field: ExternalType;
}
`;

  // Create project with both files
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.ts', sourceInput);
  const externalFile = project.createSourceFile('external.ts', externalInput);

  // Verify no initial type errors
  const initialDiagnostics = project.getPreEmitDiagnostics();
  assert.equal(initialDiagnostics.length, 0, 'Should have no type errors initially');

  // Parse and analyze
  const moduleInfo = parseIsolatedSourceCode(sourceInput);
  const deps = buildIntraModuleDependencies(moduleInfo);

  // Split MyInterface
  const analysis = analyzeSplit(deps, 'MyInterface');
  const allSymbolsToMove = new Set(['MyInterface']);
  for (const dep of analysis.requiredDependencies) {
    allSymbolsToMove.add(dep);
  }

  console.log('Symbols to move:', Array.from(allSymbolsToMove).sort());

  // Generate split
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, allSymbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);

  // Generate target
  const actualTarget = generateNewModuleSource(symbolDefinitions, requiredImports);

  // Generate modified source - chain transformations
  let actualSource = removeSymbolsFromSource(sourceFile, allSymbolsToMove);
  const sourceAfterRemoval = project.createSourceFile(`temp-after-removal-${Date.now()}.ts`, actualSource);
  actualSource = removeUnusedImports(sourceAfterRemoval, allSymbolsToMove, onlyUsedByTarget);
  const sourceAfterCleanup = project.createSourceFile(`temp-after-cleanup-${Date.now()}.ts`, actualSource);
  actualSource = addImportForMovedSymbols(sourceAfterCleanup, allSymbolsToMove, './target', true);

  // Update project files
  project.createSourceFile('target.ts', actualTarget);
  sourceFile.replaceWithText(actualSource);

  console.log('=== Generated target.ts ===');
  console.log(actualTarget);
  console.log('=== Generated source.ts ===');
  console.log(actualSource);

  // Verify target has the import
  assert.include(actualTarget, "import type ExternalType from", 
    'Target should have the type-only default import');
  assert.include(actualTarget, "from \"./external\"", 
    'Target should import from ./external');
  assert.include(actualTarget, 'export interface MyInterface', 
    'Target should export MyInterface');
  assert.include(actualTarget, 'field: ExternalType', 
    'MyInterface should reference ExternalType');

  // Verify source has re-export
  assert.include(actualSource, "export { MyInterface } from \"./target\"", 
    'Source should re-export MyInterface');
  assert.include(actualSource, 'export const helperFunc', 
    'Source should keep helperFunc');
  
  // Verify source doesn't have the interface definition
  assert.notInclude(actualSource, 'interface MyInterface {', 
    'Source should not have MyInterface definition');

  // Verify no type errors after split
  const finalDiagnostics = project.getPreEmitDiagnostics();
  
  if (finalDiagnostics.length > 0) {
    console.error('Type errors after split:');
    for (const diag of finalDiagnostics) {
      const file = diag.getSourceFile();
      const lineNumber = file?.getLineAndColumnAtPos(diag.getStart() ?? 0);
      console.error(`  ${file?.getFilePath()}:${lineNumber?.line}: ${diag.getMessageText()}`);
    }
  }

  assert.equal(
    finalDiagnostics.length,
    0,
    'Should have no type errors after split'
  );

  console.log('✅ Type-only default imports handled correctly!');
});
