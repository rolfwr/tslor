import { assert, test } from 'vitest';
import { Project, SourceFile } from 'ts-morph';
import { applyReexportRemovalsToFile } from './runProposePurgeReexport';

/**
 * Create a source file from source code for testing
 */
function createTestSourceFile(sourceCode: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('test.ts', sourceCode);
}

test('applyReexportRemovalsToFile preserves type keyword for individual exports', () => {
  const source = `
export {
  ValueExport1,
  ValueExport2,
  type TypeExport1,
  type TypeExport2,
  UnusedValue,
  type UnusedType
} from './mixed';
`;

  const sourceFile = createTestSourceFile(source);

  // Remove some exports but keep the mixed type/value nature
  const reExportsToRemove = [
    { symbolName: 'UnusedValue', originalModuleSpec: './mixed', isTypeOnly: false },
    { symbolName: 'UnusedType', originalModuleSpec: './mixed', isTypeOnly: true }
  ];

  applyReexportRemovalsToFile(sourceFile, reExportsToRemove, 'test.ts');

  const result = sourceFile.getFullText();

  // Should preserve the type keyword for type-only exports
  assert.include(result, 'type TypeExport1', 'Should preserve type keyword for TypeExport1');
  assert.include(result, 'type TypeExport2', 'Should preserve type keyword for TypeExport2');
  
  // Should keep value exports without type keyword
  assert.include(result, 'ValueExport1');
  assert.include(result, 'ValueExport2');
  
  // Should remove unused exports
  assert.notInclude(result, 'UnusedValue');
  assert.notInclude(result, 'UnusedType');

  console.log('Modified source with mixed type/value exports:');
  console.log(result);
});

test('applyReexportRemovalsToFile removes unused re-exports', () => {
  const source = `
import { helper } from './utils';

export { formatDate } from './date-utils';
export type { ItemDto, UnusedType } from './types';
export { usedFunction, unusedFunction } from './functions';

export function localFunction(): void {
  helper();
}
`;

  const sourceFile = createTestSourceFile(source);

  // Simulate removing specific re-exports
  const reExportsToRemove = [
    { symbolName: 'formatDate', originalModuleSpec: './date-utils', isTypeOnly: false },
    { symbolName: 'UnusedType', originalModuleSpec: './types', isTypeOnly: true },
    { symbolName: 'unusedFunction', originalModuleSpec: './functions', isTypeOnly: false }
  ];

  applyReexportRemovalsToFile(sourceFile, reExportsToRemove, 'test.ts');

  const result = sourceFile.getFullText();

  // Should remove formatDate from the first export declaration (completely)
  assert.notInclude(result, "export { formatDate } from './date-utils';");

  // Should keep the type export but remove UnusedType, leaving only ItemDto
  assert.include(result, "export type { ItemDto } from './types';");
  assert.notInclude(result, 'UnusedType');

  // Should keep the value export but remove unusedFunction, leaving only usedFunction
  assert.include(result, "export { usedFunction } from './functions';");
  assert.notInclude(result, 'unusedFunction');

  // Should keep the import and local function
  assert.include(result, "import { helper } from './utils';");
  assert.include(result, 'export function localFunction()');

  console.log('Modified source after removing unused re-exports:');
  console.log(result);
});

test('applyReexportRemovalsToFile removes entire export declaration when all symbols unused', () => {
  const source = `
export { usedFunction } from './functions';
export type { UnusedType1, UnusedType2 } from './types';
export { anotherUsed } from './other';
`;

  const sourceFile = createTestSourceFile(source);

  // Remove all symbols from the type export declaration
  const reExportsToRemove = [
    { symbolName: 'UnusedType1', originalModuleSpec: './types', isTypeOnly: true },
    { symbolName: 'UnusedType2', originalModuleSpec: './types', isTypeOnly: true }
  ];

  applyReexportRemovalsToFile(sourceFile, reExportsToRemove, 'test.ts');

  const result = sourceFile.getFullText();

  // Should remove the entire type export declaration
  assert.notInclude(result, "export type { UnusedType1, UnusedType2 } from './types';");

  // Should keep the other exports
  assert.include(result, "export { usedFunction } from './functions';");
  assert.include(result, "export { anotherUsed } from './other';");

  console.log('Source after removing entire export declaration:');
  console.log(result);
});
