import { DebugOptions } from "./objstore.js";
import { runProposeSplit } from "./runProposeSplit.js";
import { runApply } from "./runApply.js";
import { PLAN_FILE_NAME } from "./plan.js";
import { existsSync } from "fs";
import { promises as fsp } from "fs";
import { FileSystem } from "./filesystem.js";

interface SplitOptions {
  dryRun?: boolean;
}

/**
 * Split command (convenience wrapper for propose + apply).
 * 
 * This command combines propose-split and apply into a single operation
 * for quick refactoring workflows. For team coordination or high-risk
 * refactorings, use propose-split + apply separately.
 * 
 * NOTE: --dry-run is deprecated. Use propose-split to review plans.
 */
export async function runSplit(
  sourceModuleArg: string,
  targetModuleArg: string,
  symbols: string[],
  options: SplitOptions,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
) {
  if (options.dryRun) {
    console.warn('Warning: --dry-run is deprecated. Use "tslor propose-split" to review plans.');
    console.warn('Falling back to propose-split behavior.\n');
    
    // Just propose, don't apply
    await runProposeSplit(sourceModuleArg, targetModuleArg, symbols, debugOptions, fileSystem);
    return;
  }

  // Convenience wrapper: propose + apply in one command
  console.log('Split command: propose + apply\n');
  
  // Step 1: Propose
  await runProposeSplit(sourceModuleArg, targetModuleArg, symbols, debugOptions, fileSystem);
  
  // Step 2: Apply
  console.log('');
  await runApply(undefined, {}, debugOptions);
  
  // Step 3: Clean up temporary plan file
  try {
    if (existsSync(PLAN_FILE_NAME)) {
      await fsp.unlink(PLAN_FILE_NAME);
    }
  } catch (error) {
    // Ignore cleanup errors
  }
  
  console.log('');
  console.log('Split operation completed');
}
