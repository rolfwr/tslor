/**
 * Propose Purge Re-export Command
 *
 * Scans the codebase for unused re-exports and proposes removing them.
 * This is the cleanup phase after propose-import-directly has moved imports.
 */

import { openStorage, Storage } from "./storage.js";
import { DebugOptions } from "./objstore.js";
import { normalizeAndValidatePath } from "./pathUtils.js";
import { TslorPlan, PLAN_VERSION, PLAN_FILE_NAME, computeFileChecksum, computeStringChecksum, writePlan, displayPlan, ModifyFileChange } from "./plan.js";
import { promises as fsp } from "fs";
import { SourceFile, ExportDeclaration } from "ts-morph";
import { loadSourceFile } from "./indexing.js";
import { reinsertScript } from "./transformingFileSystem.js";
import { RepositoryRootProvider, GitRepositoryRootProvider, InMemoryRepositoryRootProvider } from "./repositoryRootProvider.js";
import { FileSystem, RealFileSystem, InMemoryFileSystem } from "./filesystem.js";

/**
 * Propose removing unused re-exports from the codebase.
 */
export async function runProposePurgeReexport(directoryArg: string, debugOptions: DebugOptions, repoProvider: RepositoryRootProvider, fileSystem: FileSystem): Promise<TslorPlan> {
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;

  const directory = normalizeAndValidatePath(directoryArg, "Directory", isInMemory);
  console.log(`Scanning codebase in ${directory} for unused re-exports...`);

  // Find repository root
  const repoRoot = repoProvider.findRepositoryRoot(directory);

  // Build/update the index for files in the specified directory only
  const db = openStorage(debugOptions, true);
  const allPaths = await repoProvider.getTypeScriptFilePaths(repoRoot, true);
  const filteredPaths = allPaths.filter((path: string) => path.startsWith(directory));

  const { indexImportFromFiles } = await import('./indexing.js');
  await indexImportFromFiles(filteredPaths, db, repoRoot, true, fileSystem);
  db.save();

  // Find all re-exports in the codebase
  const allReExports = findAllReExports(db);

  if (allReExports.length === 0) {
    console.log('No re-exports found in the codebase.');
    return createEmptyPlan();
  }

  console.log(`Found ${allReExports.length} re-exported symbols`);

  // Find unused re-exports (those with no external importers)
  const unusedReExports = await findUnusedReExports(db, allReExports);

  if (unusedReExports.length === 0) {
    console.log('No unused re-exports found.');
    return createEmptyPlan();
  }

  console.log(`Found ${unusedReExports.length} unused re-exports that can be removed`);

  // Create plan with the changes
  const plan = await createPurgeReexportPlan(unusedReExports, fileSystem);

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
 * Find re-exports that are not imported by any external modules
 */
async function findUnusedReExports(
  db: Storage,
  allReExports: Array<{ reExporterPath: string; symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }>
): Promise<Array<{ reExporterPath: string; symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }>> {
  const unusedReExports: Array<{ reExporterPath: string; symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }> = [];

  for (const reExport of allReExports) {
    // Check if anyone imports this symbol from the re-exporter
    const importers = db.getImportersOfExport(reExport.reExporterPath, reExport.symbolName);

    if (importers.length === 0) {
      // No external imports found - this re-export is unused
      unusedReExports.push(reExport);
    }
  }

  return unusedReExports;
}

/**
 * Create a plan with re-export removal changes
 */
async function createPurgeReexportPlan(
  unusedReExports: Array<{ reExporterPath: string; symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }>,
  fileSystem: FileSystem
): Promise<TslorPlan> {
  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = [];
  const sourceFiles = new Set<string>();
  const checksums: { [filePath: string]: string } = {};

  // Group changes by file
  const changesByFile = new Map<string, typeof unusedReExports>();
  for (const reExport of unusedReExports) {
    if (!changesByFile.has(reExport.reExporterPath)) {
      changesByFile.set(reExport.reExporterPath, []);
    }
    changesByFile.get(reExport.reExporterPath)!.push(reExport);
  }

  // Process each file
  for (const [filePath, fileReExports] of changesByFile) {
    const fileChecksum = await computeFileChecksum(filePath);

    // Read the original file content for Vue file reconstruction and undo
    const originalContent = await fsp.readFile(filePath, 'utf-8');

    // Load the file through TransformingFileSystem for proper AST analysis
    const sourceFile = await loadSourceFile(filePath, fileSystem);

    // Apply re-export removal changes
    applyReexportRemovalsToFile(sourceFile, fileReExports, filePath);

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

      // Create undo change to restore original content
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

  return {
    version: PLAN_VERSION,
    command: 'propose-purge-reexport',
    timestamp: new Date().toISOString(),
    sourceFiles: Array.from(sourceFiles),
    targetFiles: [],
    checksums,
    changes,
    undo
  };
}

/**
 * Apply re-export removal changes to a source file
 */
export function applyReexportRemovalsToFile(
  sourceFile: SourceFile,
  reExportsToRemove: Array<{ symbolName: string; originalModuleSpec: string; isTypeOnly: boolean }>,
  filePath: string
): void {
  try {
    // Group re-exports by module spec for efficiency
    const reExportsBySpec = new Map<string, typeof reExportsToRemove>();
    for (const reExport of reExportsToRemove) {
      if (!reExportsBySpec.has(reExport.originalModuleSpec)) {
        reExportsBySpec.set(reExport.originalModuleSpec, []);
      }
      reExportsBySpec.get(reExport.originalModuleSpec)!.push(reExport);
    }

    // Find and update export declarations
    sourceFile.getExportDeclarations().forEach((exportDecl: ExportDeclaration) => {
      try {
        const moduleSpec = exportDecl.getModuleSpecifier()?.getLiteralValue();
        if (!moduleSpec) return; // Not a re-export

        const specReExports = reExportsBySpec.get(moduleSpec);
        if (!specReExports) return;

        // Get all named exports from this declaration
        const namedExports = exportDecl.getNamedExports();
        const symbolsToRemove = new Set(specReExports.map(reExport => reExport.symbolName));

        // Filter out the exports we want to remove
        const remainingExports = namedExports.filter(namedExport =>
          !symbolsToRemove.has(namedExport.getName())
        );

        if (remainingExports.length === 0) {
          // Remove the entire export declaration
          exportDecl.remove();
        } else if (remainingExports.length < namedExports.length) {
          // Remove specific exports from the declaration using AST manipulation
          namedExports.forEach(namedExport => {
            if (symbolsToRemove.has(namedExport.getName())) {
              namedExport.remove();
            }
          });
        }
        // If all exports remain, leave the declaration unchanged

      } catch (exportError) {
        const exportText = exportDecl.getText().trim();
        const errorMessage = exportError instanceof Error ? exportError.message : String(exportError);
        throw new Error(`Failed to process export statement in ${filePath}: ${errorMessage}\nExport statement: ${exportText}`);
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to apply re-export removals to ${filePath}: ${errorMessage}`);
  }
}

/**
 * Create an empty plan when no changes are needed
 */
function createEmptyPlan(): TslorPlan {
  return {
    version: PLAN_VERSION,
    command: 'propose-purge-reexport',
    timestamp: new Date().toISOString(),
    sourceFiles: [],
    targetFiles: [],
    checksums: {},
    changes: [],
    undo: []
  };
}