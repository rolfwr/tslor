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
  await displayPlan(plan);

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
      const symbolName = symbolNameGroup.split('|')[1];
      reExports.push({
        reExporterPath: reExportObj.id.split('|')[1],
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
async function findImportChangesForReExports(
  db: Storage,
  reExports: Array<{ reExporterPath: string; symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }>,
  repoRoot: string,
  fileSystem: FileSystem
): Promise<Array<{ importerPath: string; symbolName: string; currentModuleSpec: string; newModuleSpec: string; isTypeOnly: boolean }>> {
  const changes: Array<{ importerPath: string; symbolName: string; currentModuleSpec: string; newModuleSpec: string; isTypeOnly: boolean }> = [];

  // Create a map from re-exporter path + symbol to original module spec
  const reExportMap = new Map<string, { originalModuleSpec: string; isTypeOnly: boolean }>();
  for (const reExport of reExports) {
    const key = `${reExport.reExporterPath}:${reExport.symbolName}`;
    reExportMap.set(key, {
      originalModuleSpec: reExport.originalModuleSpec,
      isTypeOnly: reExport.isTypeOnly
    });
  }

  // Find all imports - we need to get them from the objStore since there's no getAllImports method
  const allImports: Obj[] = [];
  for (const [id, obj] of db['objStore']['objs']) {
    if (id.startsWith('import|')) {
      allImports.push(obj);
    }
  }

  // Cache: importer path -> map of (resolved absolute exporter path -> literal module specifier)
  const literalSpecCache = new Map<string, Map<string, string>>();

  async function getLiteralModuleSpec(importerPath: string, exporterPath: string): Promise<string | undefined> {
    if (!literalSpecCache.has(importerPath)) {
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
      literalSpecCache.set(importerPath, specMap);
    }
    return literalSpecCache.get(importerPath)!.get(exporterPath);
  }

  for (const importObj of allImports) {
    const parts = importObj.id.split('|');
    const importerPath = parts[1];

    // Extract symbol name from the export group
    const exportGroup = importObj.groups?.find((g: string) => g.startsWith('export|'));
    if (!exportGroup) continue;

    const exportParts = exportGroup.split('|');
    if (exportParts.length < 3) continue;

    const exporterPath = exportParts[1];
    const symbolName = exportParts[2];

    // Check if this import is from a re-exporter
    const key = `${exporterPath}:${symbolName}`;
    const reExportInfo = reExportMap.get(key);

    if (reExportInfo) {
      /*
        Get the literal module specifier from the source file (not the alias-resolved form).
        applyImportChangesToFile matches against the literal text in the import declaration,
        so currentModuleSpec must match that exactly.
      */
      const currentModuleSpec = await getLiteralModuleSpec(importerPath, exporterPath);
      if (!currentModuleSpec) {
        continue;
      }

      // Resolve the original module spec relative to the re-exporter to get the absolute path
      const originalModulePath = await resolveImportSpecFromIndexing(repoRoot, exporterPath, reExportInfo.originalModuleSpec, fileSystem);
      if (!originalModulePath) continue;

      /*
        Compute newModuleSpec in the same form as the source file uses.
        If the current import is a relative path, produce a relative path.
        If it's an alias, produce an alias.
      */
      let newModuleSpec: string | undefined;
      if (currentModuleSpec.startsWith('.')) {
        // Relative path: compute relative from importer to original module
        const { relative, dirname } = await import('path');
        const relPath = relative(dirname(importerPath), originalModulePath.replace(/\.ts$/, ''));
        newModuleSpec = relPath.startsWith('.') ? relPath : './' + relPath;
      } else {
        // Alias or bare specifier: use resolveImportSpecAlias
        newModuleSpec = await resolveImportSpecAlias(repoRoot, importerPath, originalModulePath, fileSystem) ?? undefined;
      }

      if (newModuleSpec && currentModuleSpec !== newModuleSpec) {
        // CRITICAL SAFETY CHECK: Verify that the symbol actually exists in the original module.
        try {
          const originalSourceFile = await loadSourceFile(originalModulePath, fileSystem);
          const originalModuleInfo = parseModule(originalSourceFile);
          if (originalModuleInfo.exportedNames.has(symbolName)) {
            changes.push({
              importerPath,
              symbolName,
              currentModuleSpec,
              newModuleSpec,
              isTypeOnly: reExportInfo.isTypeOnly
            });
          }
        } catch {
          console.warn(`Could not verify exports from ${originalModulePath}, skipping change for ${symbolName}`);
        }
      }
    }
  }

  return changes;
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
    if (!changesByFile.has(change.importerPath)) {
      changesByFile.set(change.importerPath, []);
    }
    changesByFile.get(change.importerPath)!.push(change);
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

/**
 * Apply import changes to a source file
 */
export function applyImportChangesToFile(
  sourceFile: SourceFile,
  changes: Array<{ symbolName: string; currentModuleSpec: string; newModuleSpec: string; isTypeOnly: boolean }>,
  filePath: string
): void {
  try {
    // Group changes by module spec for efficiency
    const changesBySpec = new Map<string, typeof changes>();
    for (const change of changes) {
      if (!changesBySpec.has(change.currentModuleSpec)) {
        changesBySpec.set(change.currentModuleSpec, []);
      }
      changesBySpec.get(change.currentModuleSpec)!.push(change);
    }

    // Find and update import declarations
    sourceFile.getImportDeclarations().forEach((importDecl: ImportDeclaration) => {
      try {
        const moduleSpec = importDecl.getModuleSpecifierValue();
        const specChanges = changesBySpec.get(moduleSpec);

        if (specChanges) {
          // CRITICAL SAFETY CHECK: Only change the import declaration if ALL imported symbols
          // from this module can be safely changed. This prevents partial changes that would
          // break imports where some symbols exist in the target module but others don't.
          // Get all named imports from this declaration
          const namedImports = importDecl.getNamedImports();
          const importedSymbolNames = new Set(
            namedImports.map(namedImport => namedImport.getName())
          );

          // Check if we have changes for all imported symbols
          const changedSymbols = new Set(specChanges.map(change => change.symbolName));
          const allSymbolsCanBeChanged = Array.from(importedSymbolNames).every(symbol =>
            changedSymbols.has(symbol)
          );

          if (allSymbolsCanBeChanged) {
            // All symbols can be changed safely, update the module specifier
            const newSpec = specChanges[0].newModuleSpec; // All changes for this spec should have the same new spec
            importDecl.setModuleSpecifier(newSpec);
          } else {
            /*
              Split the import: keep unchanged symbols in the original import,
              add a new import for the redirected symbols.
            */
            const isDeclarationTypeOnly = importDecl.isTypeOnly();

            /*
              Build a per-symbol type-only lookup from the original import
              BEFORE removing any nodes (removed nodes can't be queried).
              Covers both declaration-level `import type { ... }` and
              per-specifier `import { type Foo, Bar }`.
            */
            const perSymbolTypeOnly = new Map<string, boolean>();
            for (const ni of namedImports) {
              perSymbolTypeOnly.set(ni.getName(), isDeclarationTypeOnly || ni.isTypeOnly());
            }

            // Group changed symbols by their new module spec
            const byNewSpec = new Map<string, typeof specChanges>();
            for (const change of specChanges) {
              if (!importedSymbolNames.has(change.symbolName)) {
                continue;
              }
              if (!byNewSpec.has(change.newModuleSpec)) {
                byNewSpec.set(change.newModuleSpec, []);
              }
              byNewSpec.get(change.newModuleSpec)!.push(change);
            }

            // Remove redirected symbols from the original import
            for (const namedImport of namedImports) {
              if (changedSymbols.has(namedImport.getName())) {
                namedImport.remove();
              }
            }

            // Add new import declarations for each target module
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
        }
      } catch (importError) {
        const importText = importDecl.getText().trim();
        const errorMessage = importError instanceof Error ? importError.message : String(importError);
        throw new Error(`Failed to process import statement in ${filePath}: ${errorMessage}\nImport statement: ${importText}`);
      }
    });
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