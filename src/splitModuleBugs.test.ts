import { Project } from 'ts-morph';
import { assert, test } from 'vitest';
import { parseModule } from './indexing';
import {
  addImportForMovedSymbols,
  analyzeImportUsageBySymbol,
  analyzeSplit,
  buildIntraModuleDependencies,
  computeRequiredImports,
  extractSymbolDefinitions,
  findImportsOnlyUsedBySymbols,
  generateNewModuleSource,
  removeSymbolsFromSource,
  removeUnusedImports,
} from './splitModule';

/**
 * Global identifiers (Promise, Date, Error, etc.) must not be treated
 * as local definitions and must not appear in symbols-to-move or generated imports.
 */
test('global identifiers are not treated as local definitions', () => {
  const sourceCode = `
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
  const sourceFile = project.createSourceFile('async.ts', sourceCode);

  const staticModuleInfo = parseModule(sourceFile);
  const dependencies = buildIntraModuleDependencies(staticModuleInfo);

  assert.isFalse(
    dependencies.definitions.has('Promise'),
    'Promise must not be treated as a local definition',
  );
  assert.isFalse(
    dependencies.definitions.has('Date'),
    'Date must not be treated as a local definition',
  );
  assert.isFalse(
    dependencies.definitions.has('setTimeout'),
    'setTimeout must not be treated as a local definition',
  );

  const analysis = analyzeSplit(dependencies, 'Guard');
  const symbolsToMove = new Set<string>(['Guard']);
  for (const dep of analysis.requiredDependencies) {
    symbolsToMove.add(dep);
  }

  assert.isFalse(
    symbolsToMove.has('Promise'),
    'Promise must not be in symbols to move',
  );
  assert.isFalse(
    symbolsToMove.has('Date'),
    'Date must not be in symbols to move',
  );

  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
    importUsages,
    symbolsToMove,
  );
  const requiredImports = computeRequiredImports(
    symbolDefinitions,
    importUsages,
    'async.ts',
    'guard.ts',
  );

  for (const imp of requiredImports) {
    for (const name of imp.importedNames) {
      assert.notEqual(
        name,
        'Promise',
        'Promise must not appear as an imported name',
      );
      assert.notEqual(name, 'Date', 'Date must not appear as an imported name');
    }
  }

  const updatedSource = removeSymbolsFromSource(sourceFile, symbolsToMove);
  const sourceFileAfterRemoval = project.createSourceFile(
    'updated-source.ts',
    updatedSource,
  );
  const cleanedSource = removeUnusedImports(
    sourceFileAfterRemoval,
    onlyUsedByTarget,
  );
  const sourceFileForImports = project.createSourceFile(
    'source-for-imports.ts',
    cleanedSource,
  );
  const finalSource = addImportForMovedSymbols(
    sourceFileForImports,
    new Set(['Guard']),
    './guard',
    true,
    symbolDefinitions,
  );

  assert.notMatch(
    finalSource,
    /import.*Promise.*from.*guard/,
    'Source must not import Promise from the new module',
  );
  assert.notMatch(
    finalSource,
    /import.*Date.*from.*guard/,
    'Source must not import Date from the new module',
  );
});

/**
 * Shared imports: when two symbols share an import and only one is moved,
 * the new module must import the shared dependency, and the source must
 * keep it (not remove it as unused).
 */
test('Shared imports are preserved in source and added to target module', () => {
  const sourceCode = `
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
  const sourceFile = project.createSourceFile('source.ts', sourceCode);

  const staticModuleInfo = parseModule(sourceFile);
  const dependencies = buildIntraModuleDependencies(staticModuleInfo);

  const analysis = analyzeSplit(dependencies, 'movingSchema');
  const symbolsToMove = new Set<string>(['movingSchema']);
  for (const dep of analysis.requiredDependencies) {
    symbolsToMove.add(dep);
  }

  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
    importUsages,
    symbolsToMove,
  );

  assert.isFalse(
    onlyUsedByTarget.has('zod:z'),
    'z is shared between movingSchema and stayingSchema',
  );
  assert.isFalse(
    onlyUsedByTarget.has('./utils:helper'),
    'helper is used only by stayingSchema',
  );

  const requiredImports = computeRequiredImports(
    symbolDefinitions,
    importUsages,
    'source.ts',
    'target.ts',
  );

  const zodImport = requiredImports.find((imp) => imp.moduleSpec === 'zod');
  assert.isDefined(zodImport, 'zod import should be in required imports');
  assert.include(
    zodImport?.importedNames ?? [],
    'z',
    'z should be imported in the new module',
  );

  const utilsImport = requiredImports.find(
    (imp) => imp.moduleSpec === './utils',
  );
  assert.isUndefined(
    utilsImport,
    './utils should not be imported in the new module — only stayingSchema uses it',
  );

  const updatedSource = removeSymbolsFromSource(sourceFile, symbolsToMove);
  const sourceFileAfterRemoval = project.createSourceFile(
    'updated-source.ts',
    updatedSource,
  );
  const cleanedSource = removeUnusedImports(
    sourceFileAfterRemoval,
    onlyUsedByTarget,
  );

  assert.include(
    cleanedSource,
    "import { z } from 'zod'",
    'zod import must remain in source (shared with stayingSchema)',
  );
  assert.include(
    cleanedSource,
    "import { helper } from './utils'",
    'utils import must remain in source (used by stayingSchema)',
  );
});

/**
 * Regression tests for issues found in real-world cycle resolution
 */

test('removeUnusedImports removes default imports only used by moved symbols', () => {
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

  const symbolsToMove = new Set(['functionToExtract', 'helperFunction']);

  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
    importUsages,
    symbolsToMove,
  );

  // onlyUsedByTarget should include packageInfo since it's only used by moved symbols
  assert.isTrue(
    onlyUsedByTarget.has('../package.json:packageInfo'),
    'packageInfo should be identified as only used by target symbols',
  );

  removeSymbolsFromSource(sourceFile, symbolsToMove);

  const modifiedSource = removeUnusedImports(sourceFile, onlyUsedByTarget);

  // unrelatedImport should be preserved (it's used by otherFunction)
  assert.include(
    modifiedSource,
    "import * as unrelatedImport from 'some-module'",
    'Import used by remaining function should not be removed',
  );

  // Default import only used by moved symbols must be removed
  assert.notInclude(
    modifiedSource,
    "import packageInfo from '../package.json'",
    'Default import only used by moved symbols should be removed',
  );

  // otherFunction should still exist
  assert.include(
    modifiedSource,
    'export function otherFunction',
    'Non-moved function should remain',
  );
});

test('computeRequiredImports adjusts relative import paths for new location', () => {
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
  const sourceFile = project.createSourceFile(
    'clients/kelda/commands/run.ts',
    sourceCode,
  );

  const symbolsToMove = new Set(['functionToExtract', 'helperFunction']);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);

  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const requiredImports = computeRequiredImports(
    symbolDefinitions,
    importUsages,
    'clients/kelda/commands/run.ts',
    'clients/kelda/dockerImage.ts',
  );

  // From clients/kelda/commands/run.ts, '../../package.json' resolves to clients/package.json
  // From clients/kelda/dockerImage.ts, to reach clients/package.json should be '../package.json'
  assert.equal(requiredImports.length, 1, 'Should have one required import');

  const firstImport = requiredImports.at(0);
  assert.equal(
    firstImport?.moduleSpec,
    '../package.json',
    'moduleSpec should be adjusted for new file location',
  );
});

test('Combined: default import removal and path adjustment in real-world scenario', () => {
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
  const sourceFile = project.createSourceFile(
    'clients/kelda/tools/kelda/commands/run.ts',
    sourceCode,
  );

  const symbolsToMove = new Set([
    'getDefaultKeldaDockerImage',
    'getDefaultDockerImageVersion',
  ]);
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);

  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
    importUsages,
    symbolsToMove,
  );

  removeSymbolsFromSource(sourceFile, symbolsToMove);
  const modifiedSource = removeUnusedImports(sourceFile, onlyUsedByTarget);

  assert.include(
    modifiedSource,
    "import * as dotenv from 'env-cmd'",
    'dotenv import should remain in source file',
  );

  assert.include(
    modifiedSource,
    'export function parseArgs',
    'parseArgs function should remain',
  );

  // packageInfo import should be removed from source (only used by moved symbols)
  assert.notInclude(
    modifiedSource,
    'import packageInfo from',
    'packageInfo import should be removed from source',
  );

  const requiredImports = computeRequiredImports(
    symbolDefinitions,
    importUsages,
    'clients/kelda/tools/kelda/commands/run.ts',
    'clients/kelda/tools/kelda/keldaDockerImage.ts',
  );

  // From clients/kelda/tools/kelda/commands/run.ts, path is '../../../package.json'
  // which resolves to clients/package.json
  // From clients/kelda/tools/kelda/keldaDockerImage.ts to clients/package.json
  // should be '../../package.json'

  const packageImport = requiredImports.find((imp) =>
    imp.moduleSpec.includes('package.json'),
  );
  assert.isDefined(packageImport, 'Should have package.json import');

  assert.equal(
    packageImport?.moduleSpec,
    '../../package.json',
    'moduleSpec should be adjusted from ../../../package.json to ../../package.json',
  );
});

test('shared non-exported dependency is exported from target and imported in source', () => {
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

  const staticModuleInfo = parseModule(sourceFile);
  const dependencies = buildIntraModuleDependencies(staticModuleInfo);

  const analysis = analyzeSplit(dependencies, 'movingSchema');
  assert.isTrue(analysis.canSplit, 'movingSchema should be splittable');

  const symbolsToMove = new Set<string>(['movingSchema']);
  for (const dep of analysis.requiredDependencies) {
    symbolsToMove.add(dep);
  }

  // sharedSchema should be a transitive dependency
  assert.isTrue(
    symbolsToMove.has('sharedSchema'),
    'sharedSchema should be identified as a transitive dependency of movingSchema',
  );

  // Find moved symbols that remaining symbols also depend on
  const sharedNonExportedDeps = new Set<string>();
  for (const [symbol, deps] of dependencies.dependencies) {
    if (symbolsToMove.has(symbol)) {
      continue; // skip moved symbols
    }
    for (const dep of deps) {
      if (symbolsToMove.has(dep) && !dependencies.exports.has(dep)) {
        sharedNonExportedDeps.add(dep);
      }
    }
  }

  assert.isTrue(
    sharedNonExportedDeps.has('sharedSchema'),
    'sharedSchema should be identified as a shared non-exported dependency',
  );

  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
    importUsages,
    symbolsToMove,
  );
  const requiredImports = computeRequiredImports(
    symbolDefinitions,
    importUsages,
    'source.ts',
    'target.ts',
  );
  const targetContent = generateNewModuleSource(
    symbolDefinitions,
    requiredImports,
    sharedNonExportedDeps,
  );

  // sharedSchema must be exported from target since stayingSchema in source needs it
  assert.match(
    targetContent,
    /export\s+const\s+sharedSchema/,
    'sharedSchema must be exported from target module',
  );

  const updatedSource = removeSymbolsFromSource(sourceFile, symbolsToMove);
  const sourceFileAfterRemoval = project.createSourceFile(
    'updated-source.ts',
    updatedSource,
  );
  const cleanedSource = removeUnusedImports(
    sourceFileAfterRemoval,
    onlyUsedByTarget,
  );

  // Add import for shared deps (import, NOT re-export)
  const sourceFileForImports = project.createSourceFile(
    'source-for-imports.ts',
    cleanedSource,
  );
  const finalSource = addImportForMovedSymbols(
    sourceFileForImports,
    sharedNonExportedDeps,
    './target',
    false,
    symbolDefinitions,
  );

  // Source must import sharedSchema from target
  assert.match(
    finalSource,
    /import\s*\{[^}]*sharedSchema[^}]*\}\s*from\s*'\.\/target'/,
    'source must import sharedSchema from target',
  );

  // Source must NOT re-export sharedSchema (it was never exported)
  assert.notMatch(
    finalSource,
    /export\s*\{[^}]*sharedSchema/,
    'source must NOT re-export sharedSchema',
  );

  // stayingSchema must still be in source
  assert.include(
    finalSource,
    'stayingSchema',
    'stayingSchema must remain in source',
  );
});

test('removeSymbolsFromSource preserves blank lines between remaining symbols', () => {
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
  assert.match(
    result,
    /stayingA\s*=\s*1;\n\n\/\*\*/,
    'There must be a blank line between stayingA and the JSDoc comment for stayingC',
  );
});

test('object literal property names do not appear as phantom dependencies', () => {
  /*
    Property keys like `description` and `example` in `.meta({ description: '...', example: '...' })`
    must not be treated as symbol references.
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

  const staticModuleInfo = parseModule(sourceFile);
  const dependencies = buildIntraModuleDependencies(staticModuleInfo);

  /*
    `description` and `example` are property keys, NOT symbol references.
    They must not appear in the dependency graph at all.
  */
  const mySchemaUses = staticModuleInfo.identifierUses.get('mySchema') ?? [];
  assert.notInclude(
    mySchemaUses,
    'description',
    'description is a property key, not a symbol reference',
  );
  assert.notInclude(
    mySchemaUses,
    'example',
    'example is a property key, not a symbol reference',
  );

  // Verify `z` IS still tracked as a dependency (sanity check)
  assert.include(
    mySchemaUses,
    'z',
    'z should still be tracked as a dependency of mySchema',
  );

  const analysis = analyzeSplit(dependencies, 'mySchema');
  assert.isTrue(analysis.canSplit, 'mySchema should be splittable');

  const symbolsToMove = new Set<string>(['mySchema', 'MyType']);
  for (const dep of analysis.requiredDependencies) {
    symbolsToMove.add(dep);
  }

  // `description` and `example` must NOT be in the symbols to move
  assert.isFalse(
    symbolsToMove.has('description'),
    'description must not be a transitive dependency',
  );
  assert.isFalse(
    symbolsToMove.has('example'),
    'example must not be a transitive dependency',
  );

  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  const importUsages = analyzeImportUsageBySymbol(sourceFile);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
    importUsages,
    symbolsToMove,
  );
  const updatedSource = removeSymbolsFromSource(sourceFile, symbolsToMove);
  const sourceFileAfterRemoval = project.createSourceFile(
    'updated-source.ts',
    updatedSource,
  );
  const cleanedSource = removeUnusedImports(
    sourceFileAfterRemoval,
    onlyUsedByTarget,
  );
  const sourceFileForImports = project.createSourceFile(
    'source-for-imports.ts',
    cleanedSource,
  );

  const exportedMovedSymbols = new Set(
    Array.from(symbolsToMove).filter((s) => dependencies.exports.has(s)),
  );
  const finalSource = addImportForMovedSymbols(
    sourceFileForImports,
    exportedMovedSymbols,
    './target',
    true,
    symbolDefinitions,
  );

  // The critical assertion: no phantom imports of property keys
  assert.notMatch(
    finalSource,
    /import.*description/,
    'description must not appear in any import statement',
  );
  assert.notMatch(
    finalSource,
    /import.*example/,
    'example must not appear in any import statement',
  );
});
