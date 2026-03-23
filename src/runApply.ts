/**
 * Apply Command
 * 
 * Applies a proposed refactoring plan.
 * This is the "apply" half of the propose/apply pattern.
 */

import { DebugOptions } from "./objstore.js";
import {
  PLAN_FILE_NAME,
  readPlan,
  validateChecksums,
  executeChanges,
  executeUndo,
  archivePlan,
  TslorPlan
} from "./plan.js";
import { spawn } from 'child_process';

export interface ApplyOptions {
  force?: boolean;     // Apply even if checksums don't match
  verify?: string;     // Shell command to run for verification
}

/**
 * Apply a proposed refactoring plan.
 */
export async function runApply(
  planFileArg: string | undefined,
  options: ApplyOptions,
  debugOptions: DebugOptions
): Promise<void> {
  const planFile = planFileArg || PLAN_FILE_NAME;
  const force = options.force || false;

  console.log(`Reading plan from: ${planFile}`);
  
  // Read the plan
  const plan = await readPlan(planFile);
  
  console.log(`Plan command: ${plan.command}`);
  console.log(`Plan created: ${plan.timestamp}`);
  console.log(`Changes: ${plan.changes.length}`);
  console.log('');
  
  // Validate checksums
  console.log('Validating checksums...');
  try {
    await validateChecksums(plan, force);
    console.log('✓ Checksums valid');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Checksum validation failed:\n${errorMessage}`);
  }
  
  // Execute changes
  console.log('');
  console.log('Applying changes...');
  try {
    await executeChanges(plan.changes);
    console.log('✓ Changes applied');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to apply changes:\n${errorMessage}`);
  }
  
  // If verification command is provided, run it
  if (options.verify) {
    console.log('');
    console.log('Running verification command...');
    const verifySuccess = await runVerificationCommand(options.verify);
    
    if (!verifySuccess) {
      // Verification failed - rollback changes
      console.log('');
      console.log('✗ Verification failed');
      
      if (plan.undo) {
        await executeUndo(plan);
        console.log('');
        console.error('Error: Verification command failed. Changes have been rolled back.');
        process.exit(1);
      } else {
        console.error('Error: Verification command failed, but plan has no undo information.');
        console.error('Changes cannot be automatically rolled back.');
        process.exit(1);
      }
    }
    
    console.log('✓ Verification passed');
  }
  
  // Archive the plan file
  const appliedFile = await archivePlan(planFile);
  console.log('');
  console.log(`✓ Plan archived to: ${appliedFile}`);
  
  console.log('');
  console.log('Apply completed successfully');
}

/**
 * Run a verification command (shell-interpreted) and return whether it succeeded.
 */
async function runVerificationCommand(command: string): Promise<boolean> {
  console.log(`Running: ${command}`);
  console.log('');
  
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      stdio: 'inherit',  // Inherit stdin, stdout, stderr so output is visible
      shell: true        // Use shell to interpret the command
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        console.log('');
        console.log(`Verification command exited with code ${code}`);
        resolve(false);
      }
    });
    
    child.on('error', (error) => {
      console.error('');
      console.error(`Failed to run verification command: ${error.message}`);
      resolve(false);
    });
  });
}
