import { assert, test } from 'vitest';
import { Project } from 'ts-morph';
import {
  extractSymbolDefinitions,
  generateNewModuleSource,
  analyzeImportUsageBySymbol,
  findImportsOnlyUsedBySymbols,
  computeRequiredImports
} from './splitModule';

test('Bug: Interface with method signatures should be fully extracted', () => {
  const sourceCode = `
export interface MyOperations {
  // Property signature
  vfs: string;
  
  /**
   * Method signature with JSDoc
   */
  readFile(filePath: string): Promise<string>;
  
  writeFile(outputFile: string, content: string): Promise<void>;
  
  /**
   * Method with multiple parameters
   */
  processData(input: string, options: { verbose: boolean }): string;
}

export function useOperations(ops: MyOperations): void {
  // Uses the interface
}
`;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.ts', sourceCode);
  
  // Extract MyOperations interface
  const symbolsToMove = new Set(['MyOperations']);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  assert.equal(symbolDefinitions.length, 1, 'Should extract one symbol');
  assert.equal(symbolDefinitions[0].name, 'MyOperations');
  assert.equal(symbolDefinitions[0].kind, 'interface');
  
  // Generate new module with the interface
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);
  
  const newModuleSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  console.log('Generated module source:');
  console.log(newModuleSource);
  
  // BUG: The generated interface should include ALL members (property AND method signatures)
  assert.include(newModuleSource, 'vfs: string', 'Should include property signature');
  assert.include(newModuleSource, 'readFile(filePath: string): Promise<string>', 
    'BUG: Should include readFile method signature');
  assert.include(newModuleSource, 'writeFile(outputFile: string, content: string): Promise<void>',
    'BUG: Should include writeFile method signature');
  assert.include(newModuleSource, 'processData(input: string, options: { verbose: boolean }): string',
    'BUG: Should include processData method signature');
  
  // Should preserve JSDoc comments
  assert.include(newModuleSource, 'Method signature with JSDoc',
    'Should preserve JSDoc comments');
  assert.include(newModuleSource, 'Method with multiple parameters',
    'Should preserve JSDoc comments on methods');
});

test('Bug: Interface extraction loses method signatures - detailed check', () => {
  const sourceCode = `
export interface Operations {
  prop: number;
  method(): void;
}
`;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.ts', sourceCode);
  
  // Check what the original interface contains
  const originalInterface = sourceFile.getInterface('Operations');
  assert.isDefined(originalInterface, 'Interface should exist');
  
  const properties = originalInterface!.getProperties();
  const methods = originalInterface!.getMethods();
  const allMembers = originalInterface!.getMembers();
  
  console.log('Original interface analysis:');
  console.log('  Properties:', properties.length, properties.map(p => p.getName()));
  console.log('  Methods:', methods.length, methods.map(m => m.getName()));
  console.log('  All members:', allMembers.length);
  
  assert.equal(properties.length, 1, 'Should have 1 property');
  assert.equal(methods.length, 1, 'Should have 1 method');
  assert.equal(allMembers.length, 2, 'Should have 2 total members');
  
  // Now extract it
  const symbolsToMove = new Set(['Operations']);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  const requiredImports = computeRequiredImports(symbolDefinitions, importUsages, onlyUsedByTarget);
  
  const newModuleSource = generateNewModuleSource(symbolDefinitions, requiredImports);
  
  console.log('Generated source:');
  console.log(newModuleSource);
  
  // Parse the generated source to check what was actually created
  const newProject = new Project({ useInMemoryFileSystem: true });
  const newFile = newProject.createSourceFile('new.ts', newModuleSource);
  const generatedInterface = newFile.getInterface('Operations');
  
  assert.isDefined(generatedInterface, 'Generated interface should exist');
  
  const genProperties = generatedInterface!.getProperties();
  const genMethods = generatedInterface!.getMethods();
  const genMembers = generatedInterface!.getMembers();
  
  console.log('Generated interface analysis:');
  console.log('  Properties:', genProperties.length, genProperties.map(p => p.getName()));
  console.log('  Methods:', genMethods.length, genMethods.map(m => m.getName()));
  console.log('  All members:', genMembers.length);
  
  // BUG: Methods are lost during extraction
  assert.equal(genProperties.length, 1, 'Generated should have 1 property');
  assert.equal(genMethods.length, 1, 'BUG: Generated should have 1 method (currently has 0)');
  assert.equal(genMembers.length, 2, 'BUG: Generated should have 2 total members (currently has 1)');
});
