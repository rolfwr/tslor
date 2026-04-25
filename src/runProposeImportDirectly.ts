/**
 * Propose Import Directly Command
 *
 * Scans the codebase for imports of re-exported symbols and proposes
 * changing them to point directly to the original export location.
 */

import { openStorage, Storage } from "./storage";
import { DebugOptions, Obj } from "./objstore";
import { normalizeAndValidatePath } from "./pathUtils";
import { TslorPlan, PLAN_VERSION, PLAN_FILE_NAME, computeStringChecksum, writePlan, displayPlan, ModifyFileChange } from "./plan";
import { SourceFile, ImportDeclaration } from "ts-morph";
import { loadSourceFile, parseModule, resolveImportSpec as resolveImportSpecFromIndexing, resolveImportSpecAlias } from "./indexing";
import { reinsertScript } from "./transformingFileSystem";
import { isGeneratedFile } from "./generatedFileDetection";
import { RepositoryRootProvider, InMemoryRepositoryRootProvider } from "./repositoryRootProvider";
import { FileSystem } from "./filesystem";

/**
 * Propose changing imports of re-exported symbols to point directly to original exports.
 */
export async function runProposeImportDirectly(directoryArg: string, debugOptions: DebugOptions, repoProvider: RepositoryRootProvider, fileSystem: FileSystem): Promise<TslorPlan> {
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;

  const directory = normalizeAndValidatePath(directoryArg, "Directory", isInMemory);
  console.log(`Scanning codebase in ${directory} for imports of re-exported symbols...`);

  // Find repository root
  const repoRoot = repoProvider.findRepositoryRoot(directory);

  // Build/update the index for files in the specified directory only
  const db = openStorage(debugOptions, true);
  const allPaths = await repoProvider.getTypeScriptFilePaths(repoRoot, true);
  const filteredPaths = allPaths.filter((path: string) => path.startsWith(directory));

  const { indexImportFromFiles } = await import('./indexing');
  await indexImportFromFiles(filteredPaths, db, repoRoot, true, fileSystem);
  db.save();

  // Find all re-exports in the codebase
  const reExports = findAllReExports(db);

  if (reExports.length === 0) {
    console.log('No re-exports found in the codebase.');
    return createEmptyPlan();
  }

  console.log(`Found ${reExports.length} re-exported symbols`);

  // Find imports that use these re-exported symbols
  const importChanges = await findImportChangesForReExports(db, reExports, repoRoot, fileSystem);

  if (importChanges.length === 0) {
    console.log('No imports found that can be changed to point directly to original exports.');
    return createEmptyPlan();
  }

  console.log(`Found ${importChanges.length} imports that can be updated`);

  // Create plan with the changes
  const plan = await createImportDirectlyPlan(importChanges, repoRoot, fileSystem);

  // Write and display plan
  await writePlan(plan, PLAN_FILE_NAME);
  await displayPlan(plan, {});

  return plan;
}

/**
 * Find all re-exports in the codebase
 */
function findAllReExports(db: Storage): Array<{ reExporterPath: string; symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }> {
  const reExports: Array<{ reExporterPath: string; symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }> = [];

  const allReExportObjs = db.getAllReExports();

  for (const reExportObj of allReExportObjs) {
    // Extract symbol name from groups
    const symbolNameGroup = reExportObj.groups?.find((g: string) => g.startsWith('reexportName|'));
    if (symbolNameGroup) {
      const [_prefix, symbolName] = symbolNameGroup.split('|');
      if (symbolName === undefined) {
        continue;
      }
      const [reExporterPath] = reExportObj.id.split('|').slice(1);
      if (reExporterPath === undefined) {
        continue;
      }
      reExports.push({
        reExporterPath,
        symbolName,
        originalModuleSpec: reExportObj.reExport.moduleSpec,
        isTypeOnly: reExportObj.reExport.isTypeOnly
      });
    }
  }

  return reExports;
}

/**
 * Find imports that can be changed to point directly to original exports
 */
async function buildLiteralSpecMap(
  importerPath: string,
  repoRoot: string,
  fileSystem: FileSystem
): Promise<Map<string, string>> {
  const specMap = new Map<string, string>();
  try {
    const sf = await loadSourceFile(importerPath, fileSystem);
    for (const decl of sf.getImportDeclarations()) {
      const literal = decl.getModuleSpecifierValue();
      const resolved = await resolveImportSpecFromIndexing(repoRoot, importerPath, literal, fileSystem);
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
  fileSystem: FileSystem
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
  fileSystem: FileSystem
): Promise<string | undefined> {
  if (currentModuleSpec.startsWith('.')) {
    const { relative, dirname } = await import('path');
    const relPath = relative(dirname(importerPath), originalModulePath.replace(/\.ts$/, ''));
    return relPath.startsWith('.') ? relPath : './' + relPath;
  }
  return await resolveImportSpecAlias(repoRoot, importerPath, originalModulePath, fileSystem) ?? undefined;
}

async function buildImportChange(
  importerPath: string,
  exporterPath: string,
  symbolName: string,
  reExportInfo: { originalModuleSpec: string; isTypeOnly: boolean },
  literalSpecCache: Map<string, Map<string, string>>,
  repoRoot: string,
  fileSystem: FileSystem
): Promise<ImportChange & { importerPath: string } | null> {
  const currentModuleSpec = await getLiteralModuleSpec(importerPath, exporterPath, literalSpecCache, repoRoot, fileSystem);
  if (!currentModuleSpec) {
    return null;
  }
  const originalModulePath = await resolveImportSpecFromIndexing(repoRoot, exporterPath, reExportInfo.originalModuleSpec, fileSystem);
  if (!originalModulePath) {
    return null;
  }
  const newModuleSpec = await resolveNewModuleSpec(currentModuleSpec, importerPath, originalModulePath, repoRoot, fileSystem);
  if (!newModuleSpec || currentModuleSpec === newModuleSpec) {
    return null;
  }
  try {
    const originalSourceFile = await loadSourceFile(originalModulePath, fileSystem);
    const originalModuleInfo = parseModule(originalSourceFile);
    if (!originalModuleInfo.exportedNames.has(symbolName)) {
      return null;
    }
  } catch {
    console.warn(`Could not verify exports from ${originalModulePath}, skipping change for ${symbolName}`);
    return null;
  }
  return { importerPath, symbolName, currentModuleSpec, newModuleSpec, isTypeOnly: reExportInfo.isTypeOnly };
}

async function findImportChangesForReExports(
  db: Storage,
  reExports: Array<{ reExporterPath: string; symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }>,
  repoRoot: string,
  fileSystem: FileSystem
): Promise<Array<{ importerPath: string; symbolName: string; currentModuleSpec: string; newModuleSpec: string; isTypeOnly: boolean }>> {
  const changes: Array<{ importerPath: string; symbolName: string; currentModuleSpec: string; newModuleSpec: string; isTypeOnly: boolean }> = [];

  const reExportMap = new Map<string, { originalModuleSpec: string; isTypeOnly: boolean }>();
  for (const reExport of reExports) {
    reExportMap.set(`${reExport.reExporterPath}:${reExport.symbolName}`, {
      originalModuleSpec: reExport.originalModuleSpec,
      isTypeOnly: reExport.isTypeOnly
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
    const change = await buildImportChange(
      parsed.importerPath, parsed.exporterPath, parsed.symbolName,
      parsed.reExportInfo, literalSpecCache, repoRoot, fileSystem
    );
    if (change) {
      changes.push(change);
    }
  }

  return changes;
}

function parseImportObj(
  importObj: Obj,
  reExportMap: Map<string, { originalModuleSpec: string; isTypeOnly: boolean }>
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
  const exportGroup = importObj.groups?.find((g: string) => g.startsWith('export|'));
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
  importChanges: Array<{ importerPath: string; symbolName: string; currentModuleSpec: string; newModuleSpec: string; isTypeOnly: boolean }>,
  repoRoot: string,
  fileSystem: FileSystem
): Promise<TslorPlan> {
  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = []; // Undo operations to rollback changes if verification fails
  const sourceFiles = new Set<string>();
  const checksums: { [filePath: string]: string } = {};

  // Group changes by file
  const changesByFile = new Map<string, typeof importChanges>();
  for (const change of importChanges) {
    let group = changesByFile.get(change.importerPath);
    if (!group) {
      group = [];
      changesByFile.set(change.importerPath, group);
    }
    group.push(change);
  }

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
        originalChecksum: fileChecksum
      });

      // Create undo change to restore original content.
      // This enables rollback if verification fails after applying the changes.
      // The undo operation restores the file to its pre-refactoring state.
      undo.push({
        type: 'modify-file',
        path: filePath,
        content: originalContent,
        originalChecksum: computeStringChecksum(finalContent)
      });

      sourceFiles.add(filePath);
      checksums[filePath] = fileChecksum;
    }
  }

  if (skippedGenerated > 0) {
    console.log(`Skipped ${skippedGenerated} @generated file(s)`);
  }

  return {
    version: PLAN_VERSION,
    command: 'propose-import-directly',
    timestamp: new Date().toISOString(),
    sourceFiles: Array.from(sourceFiles),
    targetFiles: [],
    checksums,
    changes,
    undo
  };
}

type ImportChange = { symbolName: string; currentModuleSpec: string; newModuleSpec: string; isTypeOnly: boolean };

function splitImportDeclaration(
  sourceFile: SourceFile,
  importDecl: ImportDeclaration,
  namedImports: ReturnType<ImportDeclaration['getNamedImports']>,
  specChanges: ImportChange[],
  importedSymbolNames: Set<string>,
  changedSymbols: Set<string>
): void {
  const isDeclarationTypeOnly = importDecl.isTypeOnly();
  const perSymbolTypeOnly = new Map<string, boolean>();
  for (const ni of namedImports) {
    perSymbolTypeOnly.set(ni.getName(), isDeclarationTypeOnly || ni.isTypeOnly());
  }

  const byNewSpec = new Map<string, ImportChange[]>();
  for (const change of specChanges) {
    if (!importedSymbolNames.has(change.symbolName)) {
      continue;
    }
    let group = byNewSpec.get(change.newModuleSpec);
    if (!group) {
      group = [];
      byNewSpec.set(change.newModuleSpec, group);
    }
    group.push(change);
  }

  for (const namedImport of namedImports) {
    if (changedSymbols.has(namedImport.getName())) {
      namedImport.remove();
    }
  }

  for (const [newSpec, newSpecChanges] of byNewSpec) {
    const newNamedImports = newSpecChanges.map(c => c.symbolName);
    const allTypeOnly = newNamedImports.every(n => perSymbolTypeOnly.get(n));
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
  filePath: string
): void {
  try {
    const moduleSpec = importDecl.getModuleSpecifierValue();
    const specChanges = changesBySpec.get(moduleSpec);
    if (!specChanges) {
      return;
    }
    const namedImports = importDecl.getNamedImports();
    const importedSymbolNames = new Set(namedImports.map(ni => ni.getName()));
    const changedSymbols = new Set(specChanges.map(change => change.symbolName));
    const allSymbolsCanBeChanged = Array.from(importedSymbolNames).every(s => changedSymbols.has(s));

    if (allSymbolsCanBeChanged) {
      const firstChange = specChanges.at(0);
      if (firstChange === undefined) {
        return;
      }
      importDecl.setModuleSpecifier(firstChange.newModuleSpec);
    } else {
      splitImportDeclaration(sourceFile, importDecl, namedImports, specChanges, importedSymbolNames, changedSymbols);
    }
  } catch (importError) {
    const importText = importDecl.getText().trim();
    const errorMessage = importError instanceof Error ? importError.message : String(importError);
    throw new Error(`Failed to process import statement in ${filePath}: ${errorMessage}\nImport statement: ${importText}`);
  }
}

/**
 * Apply import changes to a source file
 */
export function applyImportChangesToFile(
  sourceFile: SourceFile,
  changes: ImportChange[],
  filePath: string
): void {
  try {
    const changesBySpec = new Map<string, ImportChange[]>();
    for (const change of changes) {
      let group = changesBySpec.get(change.currentModuleSpec);
      if (!group) {
        group = [];
        changesBySpec.set(change.currentModuleSpec, group);
      }
      group.push(change);
    }
    for (const importDecl of sourceFile.getImportDeclarations()) {
      processImportDecl(importDecl, changesBySpec, sourceFile, filePath);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to apply import changes to ${filePath}: ${errorMessage}`);
  }
}

/**
 * Create an empty plan when no changes are needed
 */
function createEmptyPlan(): TslorPlan {
  return {
    version: PLAN_VERSION,
    command: 'propose-import-directly',
    timestamp: new Date().toISOString(),
    sourceFiles: [],
    targetFiles: [],
    checksums: {},
    changes: [],
    undo: []
  };
}