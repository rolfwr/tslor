/**
 * Diff Command
 * 
 * Shows unified diff of proposed changes in a plan file.
 */

import { DebugOptions } from "./objstore";
import {
  PLAN_FILE_NAME,
  readPlan,
  displayPlanDiff
} from "./plan";

export interface DiffOptions {
  stats?: boolean;      // Show statistics instead of full diff
  namesOnly?: boolean;  // Show only file names
}

/**
 * Display unified diff of a refactoring plan.
 */
export async function runDiff(
  planFileArg: string | undefined,
  options: DiffOptions,
  debugOptions: DebugOptions
): Promise<void> {
  const planFile = planFileArg || PLAN_FILE_NAME;

  console.log(`Reading plan from: ${planFile}`);
  console.log('');
  
  // Read the plan
  const plan = await readPlan(planFile);
  
  console.log(`Plan command: ${plan.command}`);
  console.log(`Plan created: ${plan.timestamp}`);
  console.log(`Changes: ${plan.changes.length}`);
  console.log('');
  
  // Display diff
  await displayPlanDiff(plan, options);
}
