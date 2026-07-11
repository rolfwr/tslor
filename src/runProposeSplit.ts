/**
 * Propose Split Command
 *
 * Proposes splitting symbols from source module to target module.
 * Creates a plan file that can be reviewed and applied later.
 */

import { dirname, relative } from 'node:path';
import { Project } from 'ts-morph';
import { CliError } from './errors';
import { FileSystem } from './filesystem';
import { analyzeImportUsageFromStaticInfo, parseModule, StaticModuleInfo } from './staticAnalysis';
import { loadSourceFileForAnalysis } from './loadSourceFile';
import {
  denormalizePath,
  normalizeAndValidatePath,
  normalizePath,
} from './pathUtils';
import {
  CreateFileChange,
  computeStringChecksum,
  displayPlan,
  ModifyFileChange,
  PLAN_FILE_NAME,
  PLAN_VERSION,
  TslorPlan,
  writePlan,
} from './plan';
import {
  addImportForMovedSymbols,
  analyzeSplit,
  buildIntraModuleDependencies,
  computeRequiredImports,
  extractSymbolDefinitions,
  findImportsOnlyUsedBySymbols,
  findSharedNonExportedDeps,
  generateNewModuleSource,
  IntraModuleDependencies,
  removeSymbolsFromSource,
  removeUnusedImports,
  SplitAnalysis,
  validateSymbolsHaveDeclarations,
} from './splitModule';

/**
 * Propose a split operation, creating a plan file.
 * This is the "propose" half of the propose/apply pattern.
 */
export async function runProposeSplit(
  sourceModuleArg: string,
  targetModuleArg: string,
  symbols: string[],
  fileSystem: FileSystem,
  writer: (message: string) => void,
  cwd: string,
): Promise<TslorPlan> {
  if (
    !sourceModuleArg ||
    !targetModuleArg ||
    !symbols ||
    symbols.length === 0
  ) {
    throw new CliError(
      'Missing required arguments: sourceModule, targetModule, and at least one symbol',
      {},
    );
  }

  const sourceModule = normalizeAndValidatePath(
    sourceModuleArg,
    'Source module',
    false,
  );
  const targetModule = normalizePath(targetModuleArg);
  writer(
    `Proposing split from ${denormalizePath(sourceModule, cwd)} to ${denormalizePath(targetModule, cwd)}\n`,
  );
  writer(`Symbols to move: ${symbols.join(', ')}\n`);

  // Phase 1: Validation
  const { staticModuleInfo, sourceText } = await validateInputs(
    sourceModule,
    targetModule,
    symbols,
    fileSystem,
    writer,
  );

  // Phase 2: Dependency Analysis
  const { dependencies, splitAnalyses } = analyzeDependencies(
    symbols,
    staticModuleInfo,
    sourceText,
    writer,
  );

  // Phase 3: Generate Split Plan
  const allSymbolsToMove = generateSplitPlan(
    dependencies,
    splitAnalyses,
    writer,
  );

  // Safety check: prevent moving all symbols
  checkNotMovingAllSymbols(dependencies, allSymbolsToMove, writer);

  // Phase 4: Generate Changes
  const { sourceContent, targetContent, originalSourceContent } =
    generateChanges(
      sourceModule,
      targetModule,
      allSymbolsToMove,
      dependencies,
      staticModuleInfo,
      sourceText,
    );

  // Phase 5: Create Plan
  const plan = createPlan(
    sourceModule,
    targetModule,
    sourceContent,
    targetContent,
    originalSourceContent,
  );

  // Phase 6: Write and Display Plan
  await writePlan(plan, PLAN_FILE_NAME);
  await displayPlan(plan, {}, cwd, writer);

  return plan;
}

async function validateInputs(
  sourceModule: string,
  targetModule: string,
  symbols: string[],
  fileSystem: FileSystem,
  writer: (message: string) => void,
): Promise<{ staticModuleInfo: StaticModuleInfo; sourceText: string }> {
  if (!(await fileSystem.exists(sourceModule))) {
    throw new CliError(`Source module does not exist: ${sourceModule}`, {});
  }

  if (await fileSystem.exists(targetModule)) {
    throw new CliError(`Target module already exists: ${targetModule}`, {});
  }

  const sourceFile = await loadSourceFileForAnalysis(sourceModule, fileSystem);
  const staticModuleInfo = parseModule(sourceFile);
  const sourceText = sourceFile.getText();

  const invalidSymbols: string[] = [];
  for (const symbol of symbols) {
    if (!staticModuleInfo.exportedNames.has(symbol)) {
      invalidSymbols.push(symbol);
    }
  }

  if (invalidSymbols.length > 0) {
    throw new CliError(
      `The following symbols are not exported from ${sourceModule}: ${invalidSymbols.join(', ')}`,
      {},
    );
  }

  writer('✓ Input validation passed\n');

  return { staticModuleInfo, sourceText };
}

function analyzeDependencies(
  symbols: string[],
  staticModuleInfo: StaticModuleInfo,
  sourceText: string,
  writer: (message: string) => void,
): { dependencies: IntraModuleDependencies; splitAnalyses: SplitAnalysis[] } {
  const dependencies = buildIntraModuleDependencies(staticModuleInfo, sourceText);

  const splitAnalyses: SplitAnalysis[] = [];
  for (const symbol of symbols) {
    const analysis = analyzeSplit(dependencies, symbol);
    splitAnalyses.push(analysis);

    if (!analysis.canSplit) {
      throw new CliError(
        `Cannot split symbol '${symbol}': circular dependencies detected with ${analysis.circularDependencies.join(', ')}`,
        {},
      );
    }
  }

  writer('✓ Dependency analysis completed\n');

  return { dependencies, splitAnalyses };
}

function generateSplitPlan(
  dependencies: IntraModuleDependencies,
  splitAnalyses: SplitAnalysis[],
  writer: (message: string) => void,
): Set<string> {
  const allSymbolsToMove = new Set<string>();
  for (const analysis of splitAnalyses) {
    allSymbolsToMove.add(analysis.symbolToMove);
    for (const dep of analysis.requiredDependencies) {
      allSymbolsToMove.add(dep);
    }
  }

  writer(
    '✓ Split plan generated - ' + allSymbolsToMove.size + ' symbols to move\n',
  );

  return allSymbolsToMove;
}

function checkNotMovingAllSymbols(
  dependencies: IntraModuleDependencies,
  symbolsToMove: Set<string>,
  writer: (message: string) => void,
): void {
  const exportedSymbolsToMove = new Set<string>();
  for (const symbol of symbolsToMove) {
    if (dependencies.exports.has(symbol)) {
      exportedSymbolsToMove.add(symbol);
    }
  }

  const totalExports = dependencies.exports.size;
  const movingExports = exportedSymbolsToMove.size;

  if (movingExports === totalExports && totalExports > 0) {
    throw new CliError(
      `Cannot move all ${totalExports} exported symbols. ` +
        `Use 'tslor mv' to move the entire file instead.`,
      {},
    );
  }

  writer(
    `✓ Safety check passed - moving ${movingExports}/${totalExports} exported symbols\n`,
  );
}

/**
 * Generate the actual file contents for source and target.
 * This is the core transformation logic.
 */
function generateChanges(
  sourceModule: string,
  targetModule: string,
  symbolsToMove: Set<string>,
  dependencies: IntraModuleDependencies,
  staticModuleInfo: StaticModuleInfo,
  sourceText: string,
): {
  sourceContent: string;
  targetContent: string;
  originalSourceContent: string;
} {
  const originalSourceContent = sourceText;

  // Create ts-morph project and load source file
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'source.ts',
    originalSourceContent,
  );

  // Invariant: every symbol scheduled for extraction must have an actual
  // declaration — abort with CliError if a phantom name slipped into the
  // dependency graph.
  validateSymbolsHaveDeclarations(sourceFile, symbolsToMove, sourceModule);

  // Extract symbol definitions for symbols to move
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);

  // Analyze import usage to determine what imports need to move
  const importUsages = analyzeImportUsageFromStaticInfo(staticModuleInfo);
  const onlyUsedByMovedSymbols = findImportsOnlyUsedBySymbols(
    importUsages,
    symbolsToMove,
  );

  // Compute required imports for the new module with path adjustment
  const requiredImports = computeRequiredImports(
    symbolDefinitions,
    importUsages,
    sourceModule,
    targetModule,
  );

  // Find non-exported moved symbols that remaining symbols also depend on
  const sharedNonExportedDeps = findSharedNonExportedDeps(
    dependencies,
    symbolsToMove,
  );

  // Generate target module source code, exporting shared deps so source can import them
  const targetContent = generateNewModuleSource(
    symbolDefinitions,
    requiredImports,
    sharedNonExportedDeps,
  );

  // Update source module: remove moved symbols
  let sourceContent = removeSymbolsFromSource(
    originalSourceContent,
    symbolsToMove,
  );

  // Remove unused imports from source module
  sourceContent = removeUnusedImports(
    sourceContent,
    onlyUsedByMovedSymbols,
  );

  // Check if any remaining symbols need the moved symbols (for re-export)
  const remainingNeedMoved = checkIfRemainingSymbolsNeedMoved(
    symbolsToMove,
    dependencies.exports,
  );
  const relativePath = getRelativeImportPath(sourceModule, targetModule);

  if (remainingNeedMoved.size > 0) {
    // Add import and re-export for moved symbols that are still needed
    sourceContent = addImportForMovedSymbols(
      sourceContent,
      remainingNeedMoved,
      relativePath,
      true,
      symbolDefinitions,
    );
  }

  // Add imports (without re-export) for shared non-exported deps
  if (sharedNonExportedDeps.size > 0) {
    sourceContent = addImportForMovedSymbols(
      sourceContent,
      sharedNonExportedDeps,
      relativePath,
      false,
      symbolDefinitions,
    );
  }

  return {
    sourceContent,
    targetContent: targetContent,
    originalSourceContent,
  };
}

/**
 * Check if remaining symbols need moved symbols (for re-export).
 */
function checkIfRemainingSymbolsNeedMoved(
  movedSymbols: Set<string>,
  originallyExportedSymbols: Set<string>,
): Set<string> {
  // Only re-export symbols that were originally exported (not internal dependencies)
  const symbolsToReExport = new Set<string>();

  for (const symbol of movedSymbols) {
    if (originallyExportedSymbols.has(symbol)) {
      symbolsToReExport.add(symbol);
    }
  }

  return symbolsToReExport;
}

/**
 * Get relative import path from source to target.
 */
function getRelativeImportPath(
  sourceModule: string,
  targetModule: string,
): string {
  const relativePath = relative(dirname(sourceModule), targetModule);

  // Convert to module path (remove extension, ensure starts with ./ or ../)
  let modulePath = relativePath.replace(/\.ts$/, '');
  if (!modulePath.startsWith('.')) {
    modulePath = './' + modulePath;
  }

  return modulePath;
}

/**
 * Create the plan object from generated changes.
 */
function createPlan(
  sourceModule: string,
  targetModule: string,
  sourceContent: string,
  targetContent: string,
  originalSourceContent: string,
): TslorPlan {
  const sourceChecksum = computeStringChecksum(originalSourceContent);

  // Create changes
  const changes: (CreateFileChange | ModifyFileChange)[] = [
    {
      type: 'create-file',
      path: targetModule,
      content: targetContent,
    },
    {
      type: 'modify-file',
      path: sourceModule,
      content: sourceContent,
      originalChecksum: sourceChecksum,
    },
  ];

  // Create undo changes (for potential rollback)
  const undo: (
    | ModifyFileChange
    | { type: 'delete-file'; path: string; originalChecksum: string }
  )[] = [
    {
      type: 'delete-file',
      path: targetModule,
      originalChecksum: computeStringChecksum(targetContent),
    },
    {
      type: 'modify-file',
      path: sourceModule,
      content: originalSourceContent,
      originalChecksum: computeStringChecksum(sourceContent),
    },
  ];

  // Create plan
  const plan: TslorPlan = {
    version: PLAN_VERSION,
    command: 'split',
    timestamp: new Date().toISOString(),
    sourceFiles: [sourceModule],
    targetFiles: [targetModule],
    checksums: {
      [sourceModule]: sourceChecksum,
    },
    changes,
    undo,
  };

  return plan;
}
