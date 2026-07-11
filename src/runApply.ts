/**
 * Apply Command
 *
 * Applies a proposed refactoring plan.
 * This is the "apply" half of the propose/apply pattern.
 */

import { spawn } from 'child_process';
import { stderr } from 'process';
import { resolve } from 'path';
import { CliError, reThrowAsCliError } from './errors';
import {
  archivePlan as defaultArchivePlan,
  executeChanges,
  executeUndo,
  PLAN_FILE_NAME,
  readPlan,
  TslorPlan,
  validateChecksums,
} from './plan';

export interface ApplyOptions {
  force?: boolean; // Apply even if checksums don't match
  verify?: string; // Shell command to run for verification
  warn?: (message: string) => void; // Warning callback (defaults to process.stderr.write)
  writer?: (message: string) => void; // Output callback (defaults to process.stderr.write)
  archivePlan?: (planFile: string) => Promise<string>; // Archive function (defaults to plan.archivePlan)
}

export async function runApply(
  planFileArg: string | undefined,
  options: ApplyOptions,
  cwd: string,
): Promise<void> {
  const planFile = resolve(cwd, planFileArg || PLAN_FILE_NAME);
  const force = options.force || false;
  const warn = options.warn || stderr.write.bind(stderr);
  const writer = options.writer || stderr.write.bind(stderr);
  const archiveFn = options.archivePlan || defaultArchivePlan;

  writer(`Reading plan from: ${planFile}\n`);

  // Read the plan
  const plan = await readPlan(planFile);

  writer(`Plan command: ${plan.command}\n`);
  writer(`Plan created: ${plan.timestamp}\n`);
  writer(`Changes: ${plan.changes.length}\n`);
  writer('\n');

  // Validate checksums
  writer('Validating checksums...\n');
  await validateChecksums(plan, force, warn);
  writer('✓ Checksums valid\n');

  // Execute changes
  writer('\n');
  writer('Applying changes...\n');
  try {
    await executeChanges(plan.changes);
    writer('✓ Changes applied\n');
  } catch (error) {
    reThrowAsCliError(error, 'Failed to apply changes', 'unexpected');
  }

  // If verification command is provided, run it
  await runVerificationAndRollback(plan, options.verify, writer);

  // Suggest purge-reexport after split plans that create re-exports
  if (plan.command === 'split') {
    writer('\n');
    writer(
      'Tip: Run \'tslor propose-purge-reexport .\' to remove unused re-exports.\n',
    );
  }

  // Archive the plan file
  await archivePlanWithFallback(planFile, warn, archiveFn, writer);

  writer('\n');
  writer('Apply completed successfully\n');
}

/**
 * Run verification if requested; throw (with rollback) on failure.
 */
async function runVerificationAndRollback(
  plan: TslorPlan,
  verify: string | undefined,
  writer: (message: string) => void,
): Promise<void> {
  if (!verify) {
    return;
  }

  writer('\n');
  writer('Running verification command...\n');
  const verifySuccess = await runVerificationCommand(verify, writer);

  if (verifySuccess) {
    writer('✓ Verification passed\n');
    return;
  }

  // Verification failed — rollback changes
  writer('\n');
  writer('✗ Verification failed\n');

  if (plan.undo) {
    await executeUndo(plan, writer);
    writer('\n');
    throw new CliError(
      'Verification command failed. Changes have been rolled back.',
      {},
    );
  }

  throw new CliError(
    'Verification command failed, but plan has no undo information. Changes cannot be automatically rolled back.',
    {},
  );
}

/**
 * Archive the plan file after application, tolerating failures.
 *
 * If archivePlan fails (e.g., read-only filesystem, cross-device issues),
 * warn the user but do not throw — changes have already been applied,
 * and the original plan file serves as a fallback record.
 */
async function archivePlanWithFallback(
  planFile: string,
  warn: (message: string) => void,
  archiveFn: (planFile: string) => Promise<string>,
  writer: (message: string) => void,
): Promise<void> {
  try {
    const appliedFile = await archiveFn(planFile);
    writer('\n');
    writer(`✓ Plan archived to: ${appliedFile}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writer('\n');
    warn(`Warning: Could not archive plan file: ${message}\n`);
    warn(`Original plan file ${planFile} is preserved for manual archival.\n`);
  }
}

/**
 * Run a verification command (shell-interpreted) and return whether it succeeded.
 */
function runVerificationCommand(
  command: string,
  writer: (message: string) => void,
): Promise<boolean> {
  writer(`Running: ${command}\n`);
  writer('\n');

  return new Promise(function (resolve) {
    const child = spawn(command, [], {
      stdio: 'inherit',
      shell: true,
    });

    child.on('close', function (code) {
      if (code === 0) {
        resolve(true);
        return;
      }
      writer('\n');
      writer(`Verification command exited with code ${code}\n`);
      resolve(false);
    });

    child.on('error', function (error) {
      writer('\n');
      writer(`Failed to run verification command: ${error.message}\n`);
      resolve(false);
    });
  });
}
