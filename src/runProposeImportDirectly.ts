/**
 * Propose Import Directly Command
 *
 * Scans the codebase for imports of re-exported symbols and proposes
 * changing them to point directly to the original export location.
 */

import { openStorage, Storage, ReExportItem } from './storage';
import { DebugOptions, Obj } from './objstore';
import { normalizeAndValidatePath, isPathWithinDirectory } from './pathUtils';
import { groupBy } from './collections';
import {
  TslorPlan,
  PLAN_VERSION,
  PLAN_FILE_NAME,
  computeStringChecksum,
  writePlan,
  displayPlan,
  ModifyFileChange,
  createEmptyPlan,
} from './plan';
import { SourceFile, ImportDeclaration } from 'ts-morph';
import { getOrThrow } from './invariant';
import { parseModule } from './staticAnalysis';
import { loadSourceFile } from './loadSourceFile';
import { resolveImportSpec as resolveImportSpecFromIndexing, resolveImportSpecAlias } from './resolveImport';
import { FileSystem, reinsertScript } from './filesystem';
import { isGeneratedFile } from './generatedFileDetection';
import {
  RepositoryRootProvider,
  InMemoryRepositoryRootProvider,
} from './repositoryRootProvider';

/**
 * Propose changing imports of re-exported symbols to point directly to original exports.
 *
 * @param writer - Callback for progress messages; tests can supply a stub to capture output
 */
export async function runProposeImportDirectly(
  directoryArg: string,
  debugOptions: DebugOptions,
  fresh: boolean,
  repoProvider: RepositoryRootProvider,
  fileSystem: FileSystem,
  writer: (message: string) => void,
  cwd: string,
): Promise<TslorPlan> {
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;

  const directory = normalizeAndValidatePath(
    directoryArg,
    'Directory',
    isInMemory,
  );
  writer(
    `Scanning codebase in ${directory} for imports of re-exported symbols...\n`,
  );

  // Find repository root
  const repoRoot = repoProvider.findRepositoryRoot(directory);

  // Build/update the index for files in the specified directory only
  const db = openStorage(debugOptions, {
    verbose: true,
    fresh,
    basePath: repoRoot,
    inMemory: isInMemory,
  });
  const allPaths = await repoProvider.getTypeScriptFilePaths(
    repoRoot,
    fileSystem,
  );
  const filteredPaths = allPaths.filter((path: string) =>
    isPathWithinDirectory(path, directory),
  );

  const { indexImportFromFiles } = await import('./indexing');
  await indexImportFromFiles(
    filteredPaths,
    db,
    repoRoot,
    true,
    fileSystem,
    writer,
  );
  db.save();

  // Find all re-exports in the codebase
  const reExports = db.findAllReExports();

  if (reExports.length === 0) {
    writer('No re-exports found in the codebase.\n');
    return createEmptyPlan('propose-import-directly');
  }

  writer(`Found ${reExports.length} re-exported symbols\n`);

  // Find imports that use these re-exported symbols
  const importChanges = await findImportChangesForReExports(
    db,
    reExports,
    repoRoot,
    fileSystem,
    writer,
  );

  if (importChanges.length === 0) {
    writer(
      'No imports found that can be changed to point directly to original exports.\n',
    );
    return createEmptyPlan('propose-import-directly');
  }

  writer(`Found ${importChanges.length} imports that can be updated\n`);

  // Create plan with the changes
  const plan = await createImportDirectlyPlan(
    importChanges,
    repoRoot,
    fileSystem,
    writer,
  );

  // Write and display plan
  await writePlan(plan, PLAN_FILE_NAME);
  await displayPlan(plan, {}, cwd, writer);

  return plan;
}

/**
 * Find imports that can be changed to point directly to original exports
 */
async function buildLiteralSpecMap(
  importerPath: string,
  repoRoot: string,
  fileSystem: FileSystem,
): Promise<Map<string, string>> {
  const specMap = new Map<string, string>();
  try {
    const sf = await loadSourceFile(importerPath, fileSystem);
    for (const decl of sf.getImportDeclarations()) {
      const literal = decl.getModuleSpecifierValue();
      const resolved = await resolveImportSpecFromIndexing(
        repoRoot,
        importerPath,
        literal,
        fileSystem,
      );
      if (resolved) {
        specMap.set(resolved, literal);
      }
    }
  } catch {
    // If we can't load the file, leave cache empty
  }
  return specMap;
}

async function getLiteralModuleSpec(
  importerPath: string,
  exporterPath: string,
  cache: Map<string, Map<string, string>>,
  repoRoot: string,
  fileSystem: FileSystem,
): Promise<string | undefined> {
  let specMap = cache.get(importerPath);
  if (specMap === undefined) {
    specMap = await buildLiteralSpecMap(importerPath, repoRoot, fileSystem);
    cache.set(importerPath, specMap);
  }
  return specMap.get(exporterPath);
}

async function resolveNewModuleSpec(
  currentModuleSpec: string,
  importerPath: string,
  originalModulePath: string,
  repoRoot: string,
  fileSystem: FileSystem,
): Promise<string | undefined> {
  if (currentModuleSpec.startsWith('.')) {
    const { relative, dirname } = await import('path');
    const relPath = relative(
      dirname(importerPath),
      originalModulePath.replace(/\.ts$/, ''),
    );
    return relPath.startsWith('.') ? relPath : './' + relPath;
  }
  return (
    (await resolveImportSpecAlias(
      repoRoot,
      importerPath,
      originalModulePath,
      fileSystem,
    )) ?? undefined
  );
}

async function buildImportChange({
  importerPath,
  exporterPath,
  symbolName,
  reExportInfo,
  literalSpecCache,
  repoRoot,
  fileSystem,
  writer,
}: {
  importerPath: string;
  exporterPath: string;
  symbolName: string;
  reExportInfo: { originalModuleSpec: string; isTypeOnly: boolean };
  literalSpecCache: Map<string, Map<string, string>>;
  repoRoot: string;
  fileSystem: FileSystem;
  writer: (message: string) => void;
}): Promise<(ImportChange & { importerPath: string }) | null> {
  const currentModuleSpec = await getLiteralModuleSpec(
    importerPath,
    exporterPath,
    literalSpecCache,
    repoRoot,
    fileSystem,
  );
  if (!currentModuleSpec) {
    return null;
  }
  const originalModuleSpec = reExportInfo.originalModuleSpec;
  const isBarePackage =
    !originalModuleSpec.startsWith('.') && !originalModuleSpec.startsWith('/');

  let newModuleSpec: string | undefined;

  if (isBarePackage) {
    /*
      Bare package imports (e.g., 'vue', 'lodash/es') cannot be resolved to
      absolute paths — they live in node_modules. Use the original module spec
      directly as the new import target. The consumer should import from the
      same bare package.
    */
    newModuleSpec = originalModuleSpec;
  } else {
    const originalModulePath = await resolveImportSpecFromIndexing(
      repoRoot,
      exporterPath,
      originalModuleSpec,
      fileSystem,
    );
    if (!originalModulePath) {
      return null;
    }
    newModuleSpec = await resolveNewModuleSpec(
      currentModuleSpec,
      importerPath,
      originalModulePath,
      repoRoot,
      fileSystem,
    );
    if (!newModuleSpec) {
      return null;
    }

    try {
      const originalSourceFile = await loadSourceFile(
        originalModulePath,
        fileSystem,
      );
      const originalModuleInfo = parseModule(originalSourceFile);
      if (!originalModuleInfo.exportedNames.has(symbolName)) {
        return null;
      }
    } catch {
      writer(
        `Could not verify exports from ${originalModulePath}, skipping change for ${symbolName}\n`,
      );
      return null;
    }
  }

  if (currentModuleSpec === newModuleSpec) {
    return null;
  }
  return {
    importerPath,
    symbolName,
    currentModuleSpec,
    newModuleSpec,
    isTypeOnly: reExportInfo.isTypeOnly,
  };
}

async function findImportChangesForReExports(
  db: Storage,
  reExports: ReExportItem[],
  repoRoot: string,
  fileSystem: FileSystem,
  writer: (message: string) => void,
): Promise<
  Array<{
    importerPath: string;
    symbolName: string;
    currentModuleSpec: string;
    newModuleSpec: string;
    isTypeOnly: boolean;
  }>
> {
  const changes: Array<{
    importerPath: string;
    symbolName: string;
    currentModuleSpec: string;
    newModuleSpec: string;
    isTypeOnly: boolean;
  }> = [];

  const reExportMap = new Map<
    string,
    { originalModuleSpec: string; isTypeOnly: boolean }
  >();
  for (const reExport of reExports) {
    reExportMap.set(`${reExport.reExporterPath}:${reExport.symbolName}`, {
      originalModuleSpec: reExport.originalModuleSpec,
      isTypeOnly: reExport.isTypeOnly,
    });
  }

  const allImports: Obj[] = [];
  for (const [id, obj] of db['objStore']['objs']) {
    if (id.startsWith('import|')) {
      allImports.push(obj);
    }
  }

  const literalSpecCache = new Map<string, Map<string, string>>();

  for (const importObj of allImports) {
    const parsed = parseImportObj(importObj, reExportMap);
    if (parsed === null) {
      continue;
    }
    const change = await buildImportChange({
      importerPath: parsed.importerPath,
      exporterPath: parsed.exporterPath,
      symbolName: parsed.symbolName,
      reExportInfo: parsed.reExportInfo,
      literalSpecCache,
      repoRoot,
      fileSystem,
      writer,
    });
    if (change) {
      changes.push(change);
    }
  }

  return changes;
}

function parseImportObj(
  importObj: Obj,
  reExportMap: Map<string, { originalModuleSpec: string; isTypeOnly: boolean }>,
): {
  importerPath: string;
  exporterPath: string;
  symbolName: string;
  reExportInfo: { originalModuleSpec: string; isTypeOnly: boolean };
} | null {
  const parts = importObj.id.split('|');
  const importerPath = parts.at(1);
  if (importerPath === undefined) {
    return null;
  }
  const exportGroup = importObj.groups?.find((g: string) =>
    g.startsWith('export|'),
  );
  if (!exportGroup) {
    return null;
  }
  const exportParts = exportGroup.split('|');
  if (exportParts.length < 3) {
    return null;
  }
  const exporterPath = exportParts.at(1);
  const symbolName = exportParts.at(2);
  if (exporterPath === undefined || symbolName === undefined) {
    return null;
  }
  const reExportInfo = reExportMap.get(`${exporterPath}:${symbolName}`);
  if (!reExportInfo) {
    return null;
  }
  return { importerPath, exporterPath, symbolName, reExportInfo };
}

/**
 * Create a plan with import changes
 */
async function createImportDirectlyPlan(
  importChanges: Array<{
    importerPath: string;
    symbolName: string;
    currentModuleSpec: string;
    newModuleSpec: string;
    isTypeOnly: boolean;
  }>,
  repoRoot: string,
  fileSystem: FileSystem,
  writer: (message: string) => void,
): Promise<TslorPlan> {
  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = [];
  const sourceFiles = new Set<string>();
  const checksums: { [filePath: string]: string } = {};

  // Group changes by file
  const changesByFile = groupBy(importChanges, (change) => change.importerPath);

  // Process each file
  let skippedGenerated = 0;
  for (const [filePath, fileChanges] of changesByFile) {
    const originalContent = await fileSystem.readFile(filePath);

    // Skip files marked as @generated
    if (isGeneratedFile(originalContent)) {
      skippedGenerated++;
      continue;
    }

    const fileChecksum = computeStringChecksum(originalContent);

    // Load the file through TransformingFileSystem for proper AST analysis
    const sourceFile = await loadSourceFile(filePath, fileSystem);

    // Apply changes to imports
    applyImportChangesToFile(sourceFile, fileChanges, filePath);

    // Get modified script content
    const modifiedScriptContent = sourceFile.getFullText();

    // Reconstruct full file content (handles Vue files properly)
    let finalContent: string;
    if (filePath.endsWith('.vue')) {
      finalContent = reinsertScript(originalContent, modifiedScriptContent);
    } else {
      finalContent = modifiedScriptContent;
    }

    // Only include files in the plan if content actually changed
    if (finalContent !== originalContent) {
      changes.push({
        type: 'modify-file',
        path: filePath,
        content: finalContent,
        originalChecksum: fileChecksum,
      });

      /*
        Create undo change to restore original content.
        This enables rollback if verification fails after applying the changes.
        The undo operation restores the file to its pre-refactoring state.
      */
      undo.push({
        type: 'modify-file',
        path: filePath,
        content: originalContent,
        originalChecksum: computeStringChecksum(finalContent),
      });

      sourceFiles.add(filePath);
      checksums[filePath] = fileChecksum;
    }
  }

  if (skippedGenerated > 0) {
    writer(`Skipped ${skippedGenerated} @generated file(s)\n`);
  }

  return {
    version: PLAN_VERSION,
    command: 'propose-import-directly',
    timestamp: new Date().toISOString(),
    sourceFiles: Array.from(sourceFiles),
    targetFiles: [],
    checksums,
    changes,
    undo,
  };
}

type ImportChange = {
  symbolName: string;
  currentModuleSpec: string;
  newModuleSpec: string;
  isTypeOnly: boolean;
};

function splitImportDeclaration(
  sourceFile: SourceFile,
  importDecl: ImportDeclaration,
  namedImports: ReturnType<ImportDeclaration['getNamedImports']>,
  specChanges: ImportChange[],
  symbolToAlias: Map<string, string>,
): void {
  const isDeclarationTypeOnly = importDecl.isTypeOnly();
  const perSymbolTypeOnly = new Map<string, boolean>();
  for (const ni of namedImports) {
    perSymbolTypeOnly.set(
      ni.getName(),
      isDeclarationTypeOnly || ni.isTypeOnly(),
    );
  }

  const byNewSpec = groupBy(specChanges, (change) => change.newModuleSpec);

  for (const namedImport of namedImports) {
    if (specChanges.some((c) => c.symbolName === namedImport.getName())) {
      namedImport.remove();
    }
  }

  // Remove the original import if all symbols were moved
  if (importDecl.getNamedImports().length === 0) {
    importDecl.remove();
  }

  for (const [newSpec, newSpecChanges] of byNewSpec) {
    const newNamedImports = newSpecChanges.map((c) => {
      const localName = getOrThrow(
        symbolToAlias,
        c.symbolName,
        `symbolToAlias missing key ${c.symbolName}`,
      );
      if (localName !== c.symbolName) {
        return { name: c.symbolName, alias: localName };
      }
      return c.symbolName;
    });
    const allTypeOnly = newNamedImports.every((n) => {
      const originalName = typeof n === 'string' ? n : n.name;
      return perSymbolTypeOnly.get(originalName);
    });
    sourceFile.addImportDeclaration({
      moduleSpecifier: newSpec,
      namedImports: newNamedImports,
      isTypeOnly: allTypeOnly,
    });
  }
}

function processImportDecl(
  importDecl: ImportDeclaration,
  changesBySpec: Map<string, ImportChange[]>,
  sourceFile: SourceFile,
  filePath: string,
): void {
  try {
    const moduleSpec = importDecl.getModuleSpecifierValue();
    const specChanges = changesBySpec.get(moduleSpec);
    if (!specChanges) {
      return;
    }
    const namedImports = importDecl.getNamedImports();

    /*
      Build a mapping from original symbol name (e.g., resolveImportSpec)
      to local name used in this import (e.g., resolveImportSpecFromIndexing).
      `getName()` returns the original imported name, while
      `compilerNode.name.getText()` returns the local binding (alias).
      This is needed because the indexed storage only records the original name.
    */
    const symbolToAlias = new Map<string, string>();
    for (const ni of namedImports) {
      const originalName = ni.getName();
      const localName = ni.compilerNode.name.getText();
      symbolToAlias.set(originalName, localName);
    }

    /*
      Filter to only changes whose symbols are actually in this import.
      `specChanges` may contain stale index entries for symbols that are no
      longer in this declaration.
    */
    const relevantChanges = specChanges.filter(
      (c) => symbolToAlias.has(c.symbolName),
    );

    if (relevantChanges.length === 0) {
      return;
    }
    /*
      The shortcut (rewriting the module specifier in-place) is valid only
      when every symbol in the import is being changed and all changes
      redirect to the same target.
    */
    const allSymbolsCanBeChanged = Array.from(symbolToAlias.keys()).every(
      (s) => relevantChanges.some((c) => c.symbolName === s),
    );
    // biome-ignore lint/style/noNonNullAssertion: relevantChanges is non-empty (checked above).
    const firstTarget = relevantChanges[0]!.newModuleSpec;
    const allSameTarget = relevantChanges.every(
      (c) => c.newModuleSpec === firstTarget,
    );

    if (allSymbolsCanBeChanged && allSameTarget) {
      importDecl.setModuleSpecifier(firstTarget);
    } else {
      splitImportDeclaration(
        sourceFile,
        importDecl,
        namedImports,
        relevantChanges,
        symbolToAlias,
      );
    }
  } catch (importError) {
    const importText = importDecl.getText().trim();
    const errorMessage =
      importError instanceof Error ? importError.message : String(importError);
    throw new Error(
      `Failed to process import statement in ${filePath}: ${errorMessage}\nImport statement: ${importText}`,
    );
  }
}

export function applyImportChangesToFile(
  sourceFile: SourceFile,
  changes: ImportChange[],
  filePath: string,
): void {
  try {
    const changesBySpec = groupBy(
      changes,
      (change) => change.currentModuleSpec,
    );
    for (const importDecl of sourceFile.getImportDeclarations()) {
      processImportDecl(importDecl, changesBySpec, sourceFile, filePath);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to apply import changes to ${filePath}: ${errorMessage}`,
    );
  }
}
