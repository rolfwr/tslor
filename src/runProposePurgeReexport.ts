/**
 * Propose Purge Re-export Command
 *
 * Scans the codebase for unused re-exports and proposes removing them.
 * This is the cleanup phase after propose-import-directly has moved imports.
 */

import { openStorage, Storage, ReExportItem } from './storage';
import { DebugOptions } from './objstore';
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
import { SourceFile, ExportDeclaration } from 'ts-morph';
import { loadSourceFile } from './indexing';
import { reinsertScript } from './transformingFileSystem';
import {
  RepositoryRootProvider,
  InMemoryRepositoryRootProvider,
} from './repositoryRootProvider';
import { FileSystem } from './filesystem';
import { isGeneratedFile } from './generatedFileDetection';

/**
 * Filter re-exports to only those whose re-exporter file lives within the given directory.
 *
 * This scopes the command so that running against a subdirectory considers only
 * re-exports in that subdirectory, not the entire repository.
 */
export function filterReExportsByDirectory(
  reExports: ReExportItem[],
  directory: string,
): ReExportItem[] {
  return reExports.filter((reExport) =>
    isPathWithinDirectory(reExport.reExporterPath, directory),
  );
}

/**
 * Propose removing unused re-exports from the codebase.
 *
 * @param writer - Callback for progress messages; tests can supply a stub to capture output
 * @param cwd - Current working directory for path display; captured at the CLI boundary
 */
export async function runProposePurgeReexport(
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
  writer(`Scanning codebase in ${directory} for unused re-exports...\n`);

  // Find repository root
  const repoRoot = repoProvider.findRepositoryRoot(directory);

  /*
    Build/update the index — index ALL repo files so that consumers outside the
    scanned directory are visible to the unused-import check.
  */
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

  const { indexImportFromFiles } = await import('./indexing');
  await indexImportFromFiles(allPaths, db, repoRoot, true, fileSystem, writer);
  db.save();

  // Find all re-exports in the codebase
  const allReExports = db.findAllReExports();

  if (allReExports.length === 0) {
    writer('No re-exports found in the codebase.\n');
    return writeEmptyPlan('propose-purge-reexport', writer, cwd);
  }

  writer(`Found ${allReExports.length} re-exported symbols\n`);

  // Scope to the requested directory
  const scopedReExports = filterReExportsByDirectory(allReExports, directory);

  if (scopedReExports.length === 0) {
    writer(`No re-exports found within ${directory}.\n`);
    return writeEmptyPlan('propose-purge-reexport', writer, cwd);
  }

  if (scopedReExports.length < allReExports.length) {
    writer(
      `Scoped to ${scopedReExports.length} re-export(s) within ${directory} (filtered from ${allReExports.length} total)\n`,
    );
  }

  // Filter out re-exports marked with @public
  const { kept: filteredReExports, skippedPublicCount } =
    await filterPublicExports(scopedReExports, fileSystem);
  if (skippedPublicCount > 0) {
    writer(`Skipped ${skippedPublicCount} re-exports marked @public\n`);
  }

  // Find unused re-exports (those with no external importers)
  const { unused: unusedReExports, skippedNamespaceCount } =
    findUnusedReExports(db, filteredReExports);
  if (skippedNamespaceCount > 0) {
    writer(
      `Skipped ${skippedNamespaceCount} re-export(s) from files with namespace importers (import * as X).\n`,
    );
    writer(
      `Run \`tslor normalize-namespace-imports <directory>\` to convert these to named imports first.\n`,
    );
  }

  if (unusedReExports.length === 0) {
    writer('No unused re-exports found.\n');
    return writeEmptyPlan('propose-purge-reexport', writer, cwd);
  }

  // Create plan with the changes
  const { plan, skippedGeneratedCount } = await createPurgeReexportPlan(
    unusedReExports,
    fileSystem,
  );
  if (skippedGeneratedCount > 0) {
    writer(`Skipped ${skippedGeneratedCount} @generated file(s)\n`);
  }

  // Report count based on actual changes (after generated-file and no-op filtering)
  if (plan.changes.length === 0) {
    writer(
      'No removable re-exports produced file changes (all in @generated files or no-op removals).\n',
    );
  } else {
    writer(`Found ${plan.changes.length} file(s) with removable re-exports\n`);
  }

  // Write and display plan
  await writePlan(plan, PLAN_FILE_NAME);
  await displayPlan(plan, {}, cwd, writer);

  return plan;
}

/**
 * Check if an export declaration has a @public JSDoc tag in its leading comments.
 * This follows the TSDoc convention also used by Knip to mark exports as
 * intentionally public even when no TypeScript importer references them
 * (e.g., Lambda handler entry points referenced by deployment config).
 */
export function hasPublicTag(exportDecl: ExportDeclaration): boolean {
  const leadingComments = exportDecl.getLeadingCommentRanges();
  for (const comment of leadingComments) {
    const text = comment.getText();
    if (text.includes('@public')) {
      return true;
    }
  }
  return false;
}

function collectPublicSymbolsFromDecl(
  exportDecl: ExportDeclaration,
  fileReExports: ReExportItem[],
  publicSymbols: Set<string>,
): void {
  for (const namedExport of exportDecl.getNamedExports()) {
    publicSymbols.add(namedExport.getName());
  }
  if (exportDecl.getNamedExports().length === 0) {
    const moduleSpec = exportDecl.getModuleSpecifier()?.getLiteralValue();
    if (moduleSpec) {
      for (const reExport of fileReExports) {
        if (reExport.originalModuleSpec === moduleSpec) {
          publicSymbols.add(reExport.symbolName);
        }
      }
    }
  }
}

async function extractPublicSymbolsForFile(
  filePath: string,
  fileReExports: ReExportItem[],
  fileSystem: FileSystem,
): Promise<Set<string>> {
  const sourceFile = await loadSourceFile(filePath, fileSystem);
  const exportDecls = sourceFile.getExportDeclarations();
  const publicSymbols = new Set<string>();
  for (const exportDecl of exportDecls) {
    if (hasPublicTag(exportDecl)) {
      collectPublicSymbolsFromDecl(exportDecl, fileReExports, publicSymbols);
    }
  }
  return publicSymbols;
}

/**
 * Filter out re-exports whose export declarations are tagged with @public.
 */
async function filterPublicExports(
  allReExports: ReExportItem[],
  fileSystem: FileSystem,
): Promise<{ kept: ReExportItem[]; skippedPublicCount: number }> {
  const byFile = groupBy(allReExports, (reExport) => reExport.reExporterPath);

  const kept: ReExportItem[] = [];
  let skippedCount = 0;

  for (const [filePath, fileReExports] of byFile) {
    const publicSymbols = await extractPublicSymbolsForFile(
      filePath,
      fileReExports,
      fileSystem,
    );
    for (const reExport of fileReExports) {
      if (publicSymbols.has(reExport.symbolName)) {
        skippedCount++;
      } else {
        kept.push(reExport);
      }
    }
  }

  return { kept, skippedPublicCount: skippedCount };
}

/**
 * Find re-exports that are not imported by any external modules
 */
function findUnusedReExports(
  db: Storage,
  allReExports: ReExportItem[],
): { unused: ReExportItem[]; skippedNamespaceCount: number } {
  const unusedReExports: ReExportItem[] = [];
  let skippedNamespaceCount = 0;

  // Cache namespace importer lookups per re-exporter path
  const namespaceImporterCache = new Map<string, boolean>();

  for (const reExport of allReExports) {
    const importers = db.getImportersOfExport(
      reExport.reExporterPath,
      reExport.symbolName,
    );

    if (importers.length === 0) {
      let hasNamespaceImporters = namespaceImporterCache.get(
        reExport.reExporterPath,
      );
      if (hasNamespaceImporters === undefined) {
        hasNamespaceImporters =
          db.getImportersOfExport(reExport.reExporterPath, '*').length > 0;
        namespaceImporterCache.set(
          reExport.reExporterPath,
          hasNamespaceImporters,
        );
      }

      if (hasNamespaceImporters) {
        skippedNamespaceCount++;
      } else {
        unusedReExports.push(reExport);
      }
    }
  }

  return { unused: unusedReExports, skippedNamespaceCount };
}

/**
 * Create a plan with re-export removal changes
 */
async function createPurgeReexportPlan(
  unusedReExports: ReExportItem[],
  fileSystem: FileSystem,
): Promise<{ plan: TslorPlan; skippedGeneratedCount: number }> {
  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = [];
  const sourceFiles = new Set<string>();
  const checksums: { [filePath: string]: string } = {};

  const changesByFile = groupBy(
    unusedReExports,
    (reExport) => reExport.reExporterPath,
  );

  let skippedGenerated = 0;
  for (const [filePath, fileReExports] of changesByFile) {
    const originalContent = await fileSystem.readFile(filePath, 'utf-8');

    if (isGeneratedFile(originalContent)) {
      skippedGenerated++;
      continue;
    }

    const fileChecksum = computeStringChecksum(originalContent);
    const sourceFile = await loadSourceFile(filePath, fileSystem);

    applyReexportRemovalsToFile(sourceFile, fileReExports, filePath);

    const modifiedScriptContent = sourceFile.getFullText();

    let finalContent: string;
    if (filePath.endsWith('.vue')) {
      finalContent = reinsertScript(originalContent, modifiedScriptContent);
    } else {
      finalContent = modifiedScriptContent;
    }

    if (finalContent !== originalContent) {
      changes.push({
        type: 'modify-file',
        path: filePath,
        content: finalContent,
        originalChecksum: fileChecksum,
      });

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

  return {
    plan: {
      version: PLAN_VERSION,
      command: 'propose-purge-reexport',
      timestamp: new Date().toISOString(),
      sourceFiles: Array.from(sourceFiles),
      targetFiles: [],
      checksums,
      changes,
      undo,
    },
    skippedGeneratedCount: skippedGenerated,
  };
}

/**
 * Create, write, and display an empty plan when no changes are needed.
 */
async function writeEmptyPlan(
  command: string,
  writer: (message: string) => void,
  cwd: string,
): Promise<TslorPlan> {
  const plan = createEmptyPlan(command);
  await writePlan(plan, PLAN_FILE_NAME);
  await displayPlan(plan, {}, cwd, writer);
  return plan;
}

/**
 * Process a single export declaration, removing symbols that match the
 * removal set. Removes the entire declaration if all symbols are removed.
 */
function processExportDecl(
  exportDecl: ExportDeclaration,
  specReExports: ReExportItem[],
): void {
  const namedExports = exportDecl.getNamedExports();
  const symbolsToRemove = new Set(
    specReExports.map((reExport) => reExport.symbolName),
  );
  const remainingExports = namedExports.filter(
    (namedExport) => !symbolsToRemove.has(namedExport.getName()),
  );

  if (remainingExports.length === 0) {
    exportDecl.remove();
    return;
  }
  if (remainingExports.length < namedExports.length) {
    for (const namedExport of namedExports) {
      if (symbolsToRemove.has(namedExport.getName())) {
        namedExport.remove();
      }
    }
  }
}

/**
 * Apply re-export removal changes to a source file
 */
export function applyReexportRemovalsToFile(
  sourceFile: SourceFile,
  reExportsToRemove: ReExportItem[],
  filePath: string,
): void {
  try {
    const reExportsBySpec = groupBy(
      reExportsToRemove,
      (reExport) => reExport.originalModuleSpec,
    );

    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const moduleSpec = exportDecl.getModuleSpecifier()?.getLiteralValue();
      if (!moduleSpec) {
        continue;
      }
      const specReExports = reExportsBySpec.get(moduleSpec);
      if (!specReExports) {
        continue;
      }
      try {
        processExportDecl(exportDecl, specReExports);
      } catch (exportError) {
        const exportText = exportDecl.getText().trim();
        const errorMessage =
          exportError instanceof Error
            ? exportError.message
            : String(exportError);
        throw new Error(
          `Failed to process export statement in ${filePath}: ${errorMessage}\nExport statement: ${exportText}`,
        );
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to apply re-export removals to ${filePath}: ${errorMessage}`,
    );
  }
}
