/**
 * Diff Command
 *
 * Shows unified diff of proposed changes in a plan file.
 */

import { resolve } from 'path';
import { PLAN_FILE_NAME, readPlan, displayPlanDiff } from './plan';

export interface DiffOptions {
  stats?: boolean;
  namesOnly?: boolean;
}

/**
 * Display unified diff of a refactoring plan.
 */
export async function runDiff(
  planFileArg: string | undefined,
  options: DiffOptions,
  writer: (message: string) => void,
  cwd: string,
): Promise<void> {
  const planFile = resolve(cwd, planFileArg || PLAN_FILE_NAME);

  writer(`Reading plan from: ${planFile}\n`);

  // Read the plan
  const plan = await readPlan(planFile);

  writer(`Plan command: ${plan.command}\n`);
  writer(`Plan created: ${plan.timestamp}\n`);
  writer(`Changes: ${plan.changes.length}\n`);
  writer('\n');

  // Display diff
  await displayPlanDiff(plan, options, cwd, writer);
}
