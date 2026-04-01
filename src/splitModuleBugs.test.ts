import { assert, test } from 'vitest';
import { Project } from 'ts-morph';
import { parseModule } from './indexing';
import {
  buildIntraModuleDependencies,
  analyzeSplit,
  analyzeImportUsageBySymbol,
  extractSymbolDefinitions,
  findImportsOnlyUsedBySymbols,
  computeRequiredImports,
  generateNewModuleSource,
  removeSymbolsFromSource,
  removeUnusedImports,
  addImportForMovedSymbols
} from './splitModule';

/**
 * Bug reproduction tests for issues found in real-world cycle resolution
 */

test('Bug #1: removeUnusedImports should handle default imports', () => {
  // Minimal reproduction: removeUnusedImports doesn't remove default imports
  const sourceCode = `
import * as unrelatedImport from 'some-module';
import packageInfo from '../package.json';

function helperFunction(): string {
  return packageInfo.version;
}

export function functionToExtract(): string {
  return \`version: \${helperFunction()}\`;
}

export function otherFunction(): string {
  // Uses unrelatedImport which is not a dependency of functionToExtract
  return unrelatedImport.doSomething();
}
`;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('subdir/source.ts', sourceCode);
  
  // Extract functionToExtract (and its dependency helperFunction)
  const symbolsToMove = new Set(['functionToExtract', 'helperFunction']);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  // Analyze import usage
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  
  // onlyUsedByTarget should include packageInfo since it's only used by moved symbols
  assert.isTrue(onlyUsedByTarget.has('../package.json:packageInfo'),
    'packageInfo should be identified as only used by target symbols');
  
  // Remove symbols from source
  removeSymbolsFromSource(sourceFile, symbolsToMove);
  
  // Remove unused imports
  const modifiedSource = removeUnusedImports(sourceFile, symbolsToMove, onlyUsedByTarget);
  
  // unrelatedImport should be preserved (it's used by otherFunction)
  assert.include(modifiedSource, "import * as unrelatedImport from 'some-module'",
    'Import used by remaining function should not be removed');
  
  // BUG #1: packageInfo import should be removed but it's not because removeUnusedImports
  // only handles named imports, not default imports
  assert.notInclude(modifiedSource, "import packageInfo from '../package.json'",
    'BUG #1: Default import only used by moved symbols should be removed');
    
  // otherFunction should still exist
  assert.include(modifiedSource, 'export function otherFunction',
    'Non-moved function should remain');
});

test('Bug #2: computeRequiredImports should adjust relative paths', () => {
  // This test demonstrates that computeRequiredImports doesn't adjust relative paths
  // When symbols are moved from source.ts to target.ts at a different directory level,
  // the relative import paths should be recalculated
  
  const sourceCode = `
import packageInfo from '../../package.json';

function helperFunction(): string {
  return packageInfo.version;
}

export function functionToExtract(): string {
  return \`version: \${helperFunction()}\`;
}
`;

  const project = new Project({ useInMemoryFileSystem: true });
  // Source is at: clients/kelda/commands/run.ts
  const sourceFile = project.createSourceFile('clients/kelda/commands/run.ts', sourceCode);
  
  // Extract to: clients/kelda/dockerImage.ts (up one directory level)
  const symbolsToMove = new Set(['functionToExtract', 'helperFunction']);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  // Analyze imports
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  const requiredImports = computeRequiredImports(
    symbolDefinitions, 
    importUsages, 
    onlyUsedByTarget,
    'clients/kelda/commands/run.ts',
    'clients/kelda/dockerImage.ts'
  );
  
  // BUG #2 SHOULD NOW BE FIXED: requiredImports should have adjusted the moduleSpec 
  // from '../../package.json' to '../package.json'
  // because the target file is one directory level up from the source
  // 
  // From clients/kelda/commands/run.ts, '../../package.json' resolves to clients/package.json
  // From clients/kelda/dockerImage.ts, to reach clients/package.json should be '../package.json'
  
  // Currently, the moduleSpec is copied as-is without adjustment
  assert.equal(requiredImports.length, 1, 'Should have one required import');
  
  // This assertion should NOW PASS after the fix
  assert.equal(requiredImports[0].moduleSpec, '../package.json',
    'moduleSpec should be adjusted for new file location');
});

test('Combined: Both bugs in real-world scenario', () => {
  const sourceCode = `
import * as dotenv from 'env-cmd';
import packageInfo from '../../../package.json';

function getDefaultDockerImageVersion(): string {
  return packageInfo.version;
}

export function getDefaultKeldaDockerImage(): string {
  return \`docker.io/mjoll/kelda\${process.arch === 'arm64' ? '-aarch64' : ''}:\${getDefaultDockerImageVersion()}\`;
}

export function parseArgs(args: string[]): string {
  // Uses dotenv which is not a dependency of getDefaultKeldaDockerImage
  const config = dotenv.GetEnvVars({ rcFile: '.env' });
  return config.someValue;
}
`;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('clients/kelda/tools/kelda/commands/run.ts', sourceCode);
  
  // Extract to a sibling directory (up one level)
  const symbolsToMove = new Set(['getDefaultKeldaDockerImage', 'getDefaultDockerImageVersion']);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  // Analyze imports
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  
  // Update source file
  removeSymbolsFromSource(sourceFile, symbolsToMove);
  const modifiedSource = removeUnusedImports(sourceFile, symbolsToMove, onlyUsedByTarget);
  
  // Verify dotenv import is preserved in source (correct behavior)
  assert.include(modifiedSource, "import * as dotenv from 'env-cmd'",
    'dotenv import should remain in source file');
  
  // Verify parseArgs still exists
  assert.include(modifiedSource, 'export function parseArgs',
    'parseArgs function should remain');
    
  // BUG #1: packageInfo import should be removed from source (only used by moved symbols)
  // This should NOW PASS after Bug #1 fix
  assert.notInclude(modifiedSource, "import packageInfo from",
    'packageInfo import should be removed from source');
  
  // Check path adjustment (BUG #2 test - should now be fixed)
  const requiredImports = computeRequiredImports(
    symbolDefinitions, 
    importUsages, 
    onlyUsedByTarget,
    'clients/kelda/tools/kelda/commands/run.ts',
    'clients/kelda/tools/kelda/keldaDockerImage.ts'
  );
  
  // From clients/kelda/tools/kelda/commands/run.ts, path is '../../../package.json'
  // which resolves to clients/package.json
  // From clients/kelda/tools/kelda/keldaDockerImage.ts to clients/package.json
  // should be '../../package.json'
  
  const packageImport = requiredImports.find(imp => imp.moduleSpec.includes('package.json'));
  assert.isDefined(packageImport, 'Should have package.json import');
  
  // BUG #2 should now be FIXED
  assert.equal(packageImport?.moduleSpec, '../../package.json',
    'moduleSpec should be adjusted from ../../../package.json to ../../package.json');
});

test('Bug: shared non-exported dependency must be exported from target and imported in source', () => {
  // Reproduction from SPLIT_BUG.md: sharedSchema is used by both staying and moving symbols
  const sourceCode = `
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
  const sourceFile = project.createSourceFile('source.ts', sourceCode);

  // Parse and build dependency graph
  const staticModuleInfo = parseModule(sourceFile);
  const dependencies = buildIntraModuleDependencies(staticModuleInfo);

  // Analyze split for movingSchema
  const analysis = analyzeSplit(dependencies, 'movingSchema');
  assert.isTrue(analysis.canSplit, 'movingSchema should be splittable');

  // Collect all symbols to move (movingSchema + transitive deps)
  const symbolsToMove = new Set<string>(['movingSchema']);
  for (const dep of analysis.requiredDependencies) {
    symbolsToMove.add(dep);
  }

  // sharedSchema should be a transitive dependency
  assert.isTrue(symbolsToMove.has('sharedSchema'),
    'sharedSchema should be identified as a transitive dependency of movingSchema');

  // --- Detect shared non-exported deps ---
  // Find moved symbols that remaining symbols also depend on
  const sharedNonExportedDeps = new Set<string>();
  for (const [symbol, deps] of dependencies.dependencies) {
    if (symbolsToMove.has(symbol)) continue; // skip moved symbols
    for (const dep of deps) {
      if (symbolsToMove.has(dep) && !dependencies.exports.has(dep)) {
        sharedNonExportedDeps.add(dep);
      }
    }
  }

  assert.isTrue(sharedNonExportedDeps.has('sharedSchema'),
    'sharedSchema should be identified as a shared non-exported dependency');

  // Extract definitions and generate target module
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  const requiredImports = computeRequiredImports(
    symbolDefinitions, importUsages, onlyUsedByTarget,
    'source.ts', 'target.ts'
  );
  const targetContent = generateNewModuleSource(symbolDefinitions, requiredImports, sharedNonExportedDeps);

  // BUG: sharedSchema must be exported from target since stayingSchema in source needs it
  assert.match(targetContent, /export\s+const\s+sharedSchema/,
    'sharedSchema must be exported from target module');

  // Update source: remove moved symbols, clean imports
  const updatedSource = removeSymbolsFromSource(sourceFile, symbolsToMove);
  const sourceFileAfterRemoval = project.createSourceFile('updated-source.ts', updatedSource);
  const cleanedSource = removeUnusedImports(sourceFileAfterRemoval, symbolsToMove, onlyUsedByTarget);

  // Add import for shared deps (import, NOT re-export)
  const sourceFileForImports = project.createSourceFile('source-for-imports.ts', cleanedSource);
  const finalSource = addImportForMovedSymbols(
    sourceFileForImports, sharedNonExportedDeps, './target', false, symbolDefinitions
  );

  // Source must import sharedSchema from target
  assert.match(finalSource, /import\s*\{[^}]*sharedSchema[^}]*\}\s*from\s*'\.\/target'/,
    'source must import sharedSchema from target');

  // Source must NOT re-export sharedSchema (it was never exported)
  assert.notMatch(finalSource, /export\s*\{[^}]*sharedSchema/,
    'source must NOT re-export sharedSchema');

  // stayingSchema must still be in source
  assert.include(finalSource, 'stayingSchema',
    'stayingSchema must remain in source');
});

test('Bug: removeSymbolsFromSource should preserve blank lines between remaining symbols', () => {
  const sourceCode = `const stayingA = 1;

const movingB = 2;

/**
 * Staying C
 */
const stayingC = 3;
`;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.ts', sourceCode);

  const result = removeSymbolsFromSource(sourceFile, new Set(['movingB']));

  // After removing movingB, stayingA and stayingC should still be separated by a blank line
  assert.include(result, 'stayingA', 'stayingA should remain');
  assert.include(result, 'stayingC', 'stayingC should remain');
  assert.notInclude(result, 'movingB', 'movingB should be removed');

  // The key assertion: blank line between stayingA and the JSDoc for stayingC
  assert.match(result, /stayingA\s*=\s*1;\n\n\/\*\*/,
    'There must be a blank line between stayingA and the JSDoc comment for stayingC');
});

test('Bug: object literal property names should not appear as phantom dependencies', () => {
  /*
    Reproduction from _bug_phantom_imports.md:
    Property keys like `description` and `example` in `.meta({ description: '...', example: '...' })`
    are incorrectly treated as symbol references, generating bogus imports.
  */
  const sourceCode = `
import { z } from 'zod';

export const mySchema = z.string().meta({
  description: 'A string field',
  example: 'hello'
});

export type MyType = z.infer<typeof mySchema>;

export const otherSchema = z.number();
`;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.ts', sourceCode);

  // Parse and build dependency graph
  const staticModuleInfo = parseModule(sourceFile);
  const dependencies = buildIntraModuleDependencies(staticModuleInfo);

  /*
    `description` and `example` are property keys, NOT symbol references.
    They must not appear in the dependency graph at all.
  */
  const mySchemaUses = staticModuleInfo.identifierUses.get('mySchema') ?? [];
  assert.notInclude(mySchemaUses, 'description',
    'description is a property key, not a symbol reference');
  assert.notInclude(mySchemaUses, 'example',
    'example is a property key, not a symbol reference');

  // Verify `z` IS still tracked as a dependency (sanity check)
  assert.include(mySchemaUses, 'z',
    'z should still be tracked as a dependency of mySchema');

  // Now do a full split and verify no phantom imports are generated
  const analysis = analyzeSplit(dependencies, 'mySchema');
  assert.isTrue(analysis.canSplit, 'mySchema should be splittable');

  const symbolsToMove = new Set<string>(['mySchema', 'MyType']);
  for (const dep of analysis.requiredDependencies) {
    symbolsToMove.add(dep);
  }

  // `description` and `example` must NOT be in the symbols to move
  assert.isFalse(symbolsToMove.has('description'),
    'description must not be a transitive dependency');
  assert.isFalse(symbolsToMove.has('example'),
    'example must not be a transitive dependency');

  // Generate the split and check imports added back to source
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  const updatedSource = removeSymbolsFromSource(sourceFile, symbolsToMove);
  const sourceFileAfterRemoval = project.createSourceFile('updated-source.ts', updatedSource);
  const cleanedSource = removeUnusedImports(sourceFileAfterRemoval, symbolsToMove, onlyUsedByTarget);
  const sourceFileForImports = project.createSourceFile('source-for-imports.ts', cleanedSource);

  const exportedMovedSymbols = new Set(
    Array.from(symbolsToMove).filter(s => dependencies.exports.has(s))
  );
  const finalSource = addImportForMovedSymbols(
    sourceFileForImports, exportedMovedSymbols, './target', true, symbolDefinitions
  );

  // The critical assertion: no phantom imports of property keys
  assert.notMatch(finalSource, /import.*description/,
    'description must not appear in any import statement');
  assert.notMatch(finalSource, /import.*example/,
    'example must not appear in any import statement');
});
