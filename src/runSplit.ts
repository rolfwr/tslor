import { FileSystem } from './filesystem';
import { runApply } from './runApply';
import { runProposeSplit } from './runProposeSplit';

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
  fileSystem: FileSystem,
  writer: (message: string) => void,
  cwd: string,
) {
  if (options.dryRun) {
    writer(
      'Warning: --dry-run is deprecated. Use "tslor propose-split" to review plans.\n',
    );
    writer('Falling back to propose-split behavior.\n');

    // Just propose, don't apply
    await runProposeSplit(
      sourceModuleArg,
      targetModuleArg,
      symbols,
      fileSystem,
      writer,
      cwd,
    );
    return;
  }

  // Convenience wrapper: propose + apply in one command
  writer('Split command: propose + apply\n');

  // Step 1: Propose
  await runProposeSplit(
    sourceModuleArg,
    targetModuleArg,
    symbols,
    fileSystem,
    writer,
    cwd,
  );

  // Step 2: Apply
  writer('\n');
  await runApply(undefined, { writer }, cwd);

  writer('\nSplit operation completed\n');
}
