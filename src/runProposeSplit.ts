/**
 * Propose Split Command
 * 
 * Proposes splitting symbols from source module to target module.
 * Creates a plan file that can be reviewed and applied later.
 */

import { normalizeAndValidatePath, normalizePath, denormalizePath } from "./pathUtils.js";
import { existsSync } from "fs";
import { promises as fsp } from "fs";
import { loadSourceFile, parseModule, analyzeImportUsageFromStaticInfo } from "./indexing.js";
import { FileSystem } from "./filesystem.js";
import { DebugOptions } from "./objstore.js";
import {
  buildIntraModuleDependencies,
  analyzeSplit,
  extractSymbolDefinitions,
  findImportsOnlyUsedBySymbols,
  computeRequiredImports,
  generateNewModuleSource,
  removeSymbolsFromSource,
  removeUnusedImports,
  addImportForMovedSymbols,
  IntraModuleDependencies,
  SplitAnalysis
} from "./splitModule.js";
import {
  TslorPlan,
  PLAN_VERSION,
  PLAN_FILE_NAME,
  computeFileChecksum,
  computeStringChecksum,
  writePlan,
  displayPlan,
  CreateFileChange,
  ModifyFileChange
} from "./plan.js";
import { Project } from "ts-morph";

/**
 * Propose a split operation, creating a plan file.
 * This is the "propose" half of the propose/apply pattern.
 */
export async function runProposeSplit(
  sourceModuleArg: string,
  targetModuleArg: string,
  symbols: string[],
  debugOptions: DebugOptions,
  fileSystem: FileSystem
): Promise<TslorPlan> {
  if (!sourceModuleArg || !targetModuleArg || !symbols || symbols.length === 0) {
    throw new Error('Missing required arguments: sourceModule, targetModule, and at least one symbol');
  }

  const sourceModule = normalizeAndValidatePath(sourceModuleArg, "Source module", false);
  const targetModule = normalizePath(targetModuleArg);

  const cwd = process.cwd();
  console.log(`Proposing split from ${denormalizePath(sourceModule, cwd)} to ${denormalizePath(targetModule, cwd)}`);
  console.log(`Symbols to move: ${symbols.join(', ')}`);

  // Phase 1: Validation
  await validateInputs(sourceModule, targetModule, symbols, fileSystem);

  // Phase 2: Dependency Analysis  
  const { dependencies, splitAnalyses } = await analyzeDependencies(sourceModule, symbols, debugOptions, fileSystem);

  // Phase 3: Generate Split Plan
  const { allSymbolsToMove } = await generateSplitPlan(dependencies, splitAnalyses, symbols);

  // Safety check: prevent moving all symbols
  checkNotMovingAllSymbols(dependencies, allSymbolsToMove);

  // Phase 4: Generate Changes
  const { sourceContent, targetContent } = await generateChanges(
    sourceModule,
    targetModule,
    allSymbolsToMove,
    dependencies
  );

  // Phase 5: Create Plan
  const plan = await createPlan(
    sourceModule,
    targetModule,
    sourceContent,
    targetContent
  );

  // Phase 6: Write and Display Plan
  await writePlan(plan, PLAN_FILE_NAME);
  await displayPlan(plan);

  return plan;
}

/**
 * Validate inputs for split operation.
 * Extracted from runSplit for reuse.
 */
async function validateInputs(sourceModule: string, targetModule: string, symbols: string[], fileSystem: FileSystem): Promise<void> {
  // Check source module exists
  if (!existsSync(sourceModule)) {
    throw new Error(`Source module does not exist: ${sourceModule}`);
  }

  // Check target module doesn't exist
  if (existsSync(targetModule)) {
    throw new Error(`Target module already exists: ${targetModule}`);
  }

  // Validate symbols exist and are exported in source module
  const sourceFile = await loadSourceFile(sourceModule, fileSystem);
  const staticModuleInfo = parseModule(sourceFile);
  
  const invalidSymbols: string[] = [];
  for (const symbol of symbols) {
    if (!staticModuleInfo.exports.has(symbol)) {
      invalidSymbols.push(symbol);
    }
  }
  
  if (invalidSymbols.length > 0) {
    throw new Error(`The following symbols are not exported from ${sourceModule}: ${invalidSymbols.join(', ')}`);
  }

  console.log('✓ Input validation passed');
}

/**
 * Analyze dependencies for split operation.
 * Extracted from runSplit for reuse.
 */
async function analyzeDependencies(
  sourceModule: string,
  symbols: string[],
  debugOptions: DebugOptions,
  fileSystem: FileSystem
): Promise<{ dependencies: IntraModuleDependencies; splitAnalyses: SplitAnalysis[] }> {
  
  // Load and parse source module
  const sourceFile = await loadSourceFile(sourceModule, fileSystem);
  const staticModuleInfo = parseModule(sourceFile);
  
  // Build dependency graph from the module info
  const dependencies = buildIntraModuleDependencies(staticModuleInfo);
  
  // Analyze each requested symbol for splitting
  const splitAnalyses: SplitAnalysis[] = [];
  for (const symbol of symbols) {
    try {
      const analysis = analyzeSplit(dependencies, symbol);
      splitAnalyses.push(analysis);
      
      // Check if symbol can be split
      if (!analysis.canSplit) {
        throw new Error(`Cannot split symbol '${symbol}': circular dependencies detected with ${analysis.circularDependencies.join(', ')}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to analyze symbol '${symbol}': ${errorMessage}`);
    }
  }
  
  console.log('✓ Dependency analysis completed');
  
  return { dependencies, splitAnalyses };
}

/**
 * Generate split plan.
 * Extracted from runSplit for reuse.
 */
async function generateSplitPlan(
  dependencies: IntraModuleDependencies,
  splitAnalyses: SplitAnalysis[],
  requestedSymbols: string[]
): Promise<{ allSymbolsToMove: Set<string> }> {
  
  // Collect all symbols that need to move (requested + their transitive dependencies)
  const allSymbolsToMove = new Set<string>();
  
  // Add explicitly requested symbols
  for (const symbol of requestedSymbols) {
    allSymbolsToMove.add(symbol);
  }
  
  // Add all transitive dependencies for each requested symbol
  for (const analysis of splitAnalyses) {
    allSymbolsToMove.add(analysis.symbolToMove);
    for (const dep of analysis.requiredDependencies) {
      allSymbolsToMove.add(dep);
    }
  }
  
  console.log('✓ Split plan generated - ' + allSymbolsToMove.size + ' symbols to move');
  
  return { allSymbolsToMove };
}

/**
 * Safety check: prevent moving all exported symbols.
 * Extracted from runSplit for reuse.
 */
function checkNotMovingAllSymbols(dependencies: IntraModuleDependencies, symbolsToMove: Set<string>): void {
  const exportedSymbolsToMove = new Set<string>();
  for (const symbol of symbolsToMove) {
    if (dependencies.exports.has(symbol)) {
      exportedSymbolsToMove.add(symbol);
    }
  }
  
  const totalExports = dependencies.exports.size;
  const movingExports = exportedSymbolsToMove.size;
  
  if (movingExports === totalExports && totalExports > 0) {
    throw new Error(
      `Cannot move all ${totalExports} exported symbols. ` +
      `Use 'tslor mv' to move the entire file instead.`
    );
  }
  
  console.log(`✓ Safety check passed - moving ${movingExports}/${totalExports} exported symbols`);
}

/**
 * Generate the actual file contents for source and target.
 * This is the core transformation logic.
 */
async function generateChanges(
  sourceModule: string,
  targetModule: string,
  symbolsToMove: Set<string>,
  dependencies: IntraModuleDependencies
): Promise<{ sourceContent: string; targetContent: string }> {
  
  // Read source module content
  const sourceContent = await fsp.readFile(sourceModule, 'utf-8');
  
  // Create ts-morph project and load source file  
  const project = new Project({ useInMemoryFileSystem: true });
  const timestamp = Date.now();
  const sourceFile = project.createSourceFile(`source-${timestamp}.ts`, sourceContent);
  
  // Extract symbol definitions for symbols to move
  const symbolDefinitions = extractSymbolDefinitions(sourceFile, symbolsToMove);
  
  // Analyze import usage to determine what imports need to move
  const staticModuleInfo = parseModule(sourceFile);
  const importUsages = analyzeImportUsageFromStaticInfo(staticModuleInfo);
  const onlyUsedByMovedSymbols = findImportsOnlyUsedBySymbols(importUsages, symbolsToMove);
  
  // Compute required imports for the new module with path adjustment
  const requiredImports = computeRequiredImports(
    symbolDefinitions, 
    importUsages, 
    onlyUsedByMovedSymbols,
    sourceModule,
    targetModule
  );
  
  // Find non-exported moved symbols that remaining symbols also depend on
  const sharedNonExportedDeps = new Set<string>();
  for (const [symbol, deps] of dependencies.dependencies) {
    if (symbolsToMove.has(symbol)) continue;
    for (const dep of deps) {
      if (symbolsToMove.has(dep) && !dependencies.exports.has(dep)) {
        sharedNonExportedDeps.add(dep);
      }
    }
  }

  // Generate target module source code, exporting shared deps so source can import them
  const targetContent = generateNewModuleSource(symbolDefinitions, requiredImports, sharedNonExportedDeps);

  // Update source module: remove moved symbols
  const updatedSourceContent = removeSymbolsFromSource(sourceFile, symbolsToMove);

  // Remove unused imports from source module
  const sourceFileAfterRemoval = project.createSourceFile(`updated-source-${timestamp}.ts`, updatedSourceContent);
  const cleanedSourceContent = removeUnusedImports(sourceFileAfterRemoval, symbolsToMove, onlyUsedByMovedSymbols);

  // Check if any remaining symbols need the moved symbols (for re-export)
  let finalSourceContent = cleanedSourceContent;
  const remainingNeedMoved = checkIfRemainingSymbolsNeedMoved(symbolsToMove, dependencies.exports);
  const relativePath = getRelativeImportPath(sourceModule, targetModule);

  if (remainingNeedMoved.size > 0) {
    // Add import and re-export for moved symbols that are still needed
    const sourceFileForImports = project.createSourceFile(`source-for-imports-${timestamp}.ts`, finalSourceContent);
    finalSourceContent = addImportForMovedSymbols(sourceFileForImports, remainingNeedMoved, relativePath, true, symbolDefinitions);
  }

  // Add imports (without re-export) for shared non-exported deps
  if (sharedNonExportedDeps.size > 0) {
    const sourceFileForSharedImports = project.createSourceFile(`source-for-shared-${timestamp}.ts`, finalSourceContent);
    finalSourceContent = addImportForMovedSymbols(sourceFileForSharedImports, sharedNonExportedDeps, relativePath, false, symbolDefinitions);
  }
  
  return {
    sourceContent: finalSourceContent,
    targetContent: targetContent
  };
}

/**
 * Check if remaining symbols need moved symbols (for re-export).
 * Extracted from runSplit for reuse.
 */
function checkIfRemainingSymbolsNeedMoved(
  movedSymbols: Set<string>,
  originallyExportedSymbols: Set<string>
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
 * Extracted from runSplit for reuse.
 */
function getRelativeImportPath(sourceModule: string, targetModule: string): string {
  const { relative, dirname } = require('path');
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
async function createPlan(
  sourceModule: string,
  targetModule: string,
  sourceContent: string,
  targetContent: string
): Promise<TslorPlan> {
  
  // Compute checksums
  const sourceChecksum = await computeFileChecksum(sourceModule);
  
  // Create changes
  const changes: (CreateFileChange | ModifyFileChange)[] = [
    {
      type: 'create-file',
      path: targetModule,
      content: targetContent
    },
    {
      type: 'modify-file',
      path: sourceModule,
      content: sourceContent,
      originalChecksum: sourceChecksum
    }
  ];
  
  // Create undo changes (for potential rollback)
  const originalSourceContent = await fsp.readFile(sourceModule, 'utf-8');
  const undo: (ModifyFileChange | { type: 'delete-file'; path: string; originalChecksum: string })[] = [
    {
      type: 'delete-file',
      path: targetModule,
      originalChecksum: computeStringChecksum(targetContent)
    },
    {
      type: 'modify-file',
      path: sourceModule,
      content: originalSourceContent,
      originalChecksum: computeStringChecksum(sourceContent)
    }
  ];
  
  // Create plan
  const plan: TslorPlan = {
    version: PLAN_VERSION,
    command: 'split',
    timestamp: new Date().toISOString(),
    sourceFiles: [sourceModule],
    targetFiles: [targetModule],
    checksums: {
      [sourceModule]: sourceChecksum
    },
    changes,
    undo
  };
  
  return plan;
}
