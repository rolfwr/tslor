/**
 * TSLOR Plan Infrastructure
 *
 * Implements the propose/apply pattern for behavior-preserving refactorings.
 * Plan files serve as an execution contract between proposal and application.
 */

import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import * as Diff from 'diff';
import { dirname, join, relative } from 'path';
import { CliError } from './errors';
import { denormalizePath } from './pathUtils';

export const PLAN_FILE_NAME = '.tslor-plan.json';
export const PLAN_VERSION = '1.0.0';

/**
 * A TSLOR refactoring plan that can be proposed, reviewed, and applied.
 */
export interface TslorPlan {
  version: string; // Plan format version
  command: string; // Command that created this plan (e.g., "split")
  timestamp: string; // ISO 8601 timestamp when proposed
  sourceFiles: string[]; // Files being modified
  targetFiles: string[]; // Files being created

  // Checksums to detect changes since proposal
  checksums: {
    [filePath: string]: string; // SHA256 of file content
  };

  // The actual changes to apply
  changes: Change[];

  // Optional: Undo information for rollback
  undo?: Change[];
}

/**
 * Types of changes that can be applied to files
 */
export type Change = CreateFileChange | ModifyFileChange | DeleteFileChange;

export interface CreateFileChange {
  type: 'create-file';
  path: string;
  content: string;
}

export interface ModifyFileChange {
  type: 'modify-file';
  path: string;
  content: string;
  originalChecksum: string; // To verify file hasn't changed
}

export interface DeleteFileChange {
  type: 'delete-file';
  path: string;
  originalChecksum: string;
}

/**
 * Compute SHA256 checksum of a file's content.
 */
export async function computeFileChecksum(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath, 'utf-8');
  return computeStringChecksum(content);
}

/**
 * Compute SHA256 checksum of a string.
 */
export function computeStringChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Write a plan to a file.
 */
export async function writePlan(
  plan: TslorPlan,
  planFile: string,
): Promise<void> {
  const planJson = JSON.stringify(plan, null, 2);
  await fsp.writeFile(planFile, planJson, 'utf-8');
}

/**
 * Read a plan from a file.
 */
export async function readPlan(planFile: string): Promise<TslorPlan> {
  if (!existsSync(planFile)) {
    throw new CliError(`Plan file does not exist: ${planFile}`, {});
  }

  const planJson = await fsp.readFile(planFile, 'utf-8');
  // RATIONALE: JSON boundary for internal tooling, validated by validatePlanFormat
  // ast-grep-ignore: no-type-assertion
  const plan = JSON.parse(planJson) as TslorPlan;
  validatePlanFormat(plan);
  return plan;
}

/**
 * Validate that a plan has the correct format.
 */
export function validatePlanFormat(plan: TslorPlan): void {
  if (!plan.version) {
    throw new CliError('Plan missing version field', {});
  }
  if (!plan.command) {
    throw new CliError('Plan missing command field', {});
  }
  if (!plan.timestamp) {
    throw new CliError('Plan missing timestamp field', {});
  }
  if (!Array.isArray(plan.sourceFiles)) {
    throw new CliError('Plan missing sourceFiles array', {});
  }
  if (!Array.isArray(plan.targetFiles)) {
    throw new CliError('Plan missing targetFiles array', {});
  }
  if (!plan.checksums || typeof plan.checksums !== 'object') {
    throw new CliError('Plan missing checksums object', {});
  }
  if (!Array.isArray(plan.changes)) {
    throw new CliError('Plan missing changes array', {});
  }
}

/**
 * Validate that files haven't changed since plan was created.
 *
 * @param warn - Warning callback for force-mode checksum mismatch notices.
 */
export async function validateChecksums(
  plan: TslorPlan,
  force: boolean,
  warn: (message: string) => void,
): Promise<void> {
  const mismatches: string[] = [];
  const missing: string[] = [];

  for (const [filePath, expectedChecksum] of Object.entries(plan.checksums)) {
    if (!existsSync(filePath)) {
      missing.push(filePath);
      continue;
    }

    const actualChecksum = await computeFileChecksum(filePath);
    if (actualChecksum !== expectedChecksum) {
      mismatches.push(filePath);
    }
  }

  if (missing.length > 0) {
    throw new CliError(
      `The following files no longer exist:\n` +
        missing.map((f) => `  - ${f}`).join('\n') +
        `\n\nPlan cannot be applied.`,
      {},
    );
  }

  if (mismatches.length > 0 && !force) {
    throw new CliError(
      `The following files have changed since plan was created:\n` +
        mismatches.map((f) => `  - ${f}`).join('\n') +
        `\n\nPlease create a new plan or use --force to apply anyway.`,
      {},
    );
  }

  if (mismatches.length > 0 && force) {
    warn(
      'Warning: Applying plan despite checksum mismatches (--force specified)\n',
    );
    for (const file of mismatches) {
      warn(`  - ${file}\n`);
    }
  }
}

/**
 * Display a human-readable preview of the plan.
 */
export async function displayPlan(
  plan: TslorPlan,
  options: { noDiff?: boolean },
  cwd: string,
  writer: (message: string) => void,
): Promise<void> {
  writer('\n=== PROPOSED CHANGES ===\n');
  writer(`Command: ${plan.command}\n`);
  writer(`Proposed at: ${plan.timestamp}\n`);
  writer('\n');

  // Group changes by type
  const creates = plan.changes.filter(
    (c): c is CreateFileChange => c.type === 'create-file',
  );
  const modifies = plan.changes.filter(
    (c): c is ModifyFileChange => c.type === 'modify-file',
  );
  const deletes = plan.changes.filter(
    (c): c is DeleteFileChange => c.type === 'delete-file',
  );

  if (creates.length > 0) {
    writer('Files to create:\n');
    for (const change of creates) {
      const lines = change.content.split('\n').length;
      writer(`  + ${denormalizePath(change.path, cwd)} (${lines} lines)\n`);
    }
    writer('\n');
  }

  if (modifies.length > 0) {
    writer('Files to modify:\n');
    for (const change of modifies) {
      const lines = change.content.split('\n').length;
      writer(`  ~ ${denormalizePath(change.path, cwd)} (${lines} lines)\n`);
    }
    writer('\n');
  }

  if (deletes.length > 0) {
    writer('Files to delete:\n');
    for (const change of deletes) {
      writer(`  - ${denormalizePath(change.path, cwd)}\n`);
    }
    writer('\n');
  }

  writer(`Total changes: ${plan.changes.length}\n`);
  writer('\n');

  // Show unified diff (unless disabled)
  if (!options.noDiff) {
    writer('=== DIFF ===\n');
    const diff = await generatePlanDiff(plan, cwd);
    writer(diff);
    writer('\n');
  }

  writer(`Plan written to: ${PLAN_FILE_NAME}\n`);
  writer(`To apply: tslor apply\n`);
  writer(`To see diff: tslor diff\n`);
  writer('=== END PROPOSED CHANGES ===\n');
}

/**
 * Validate preconditions before executing changes.
 */
function auditChanges(changes: Change[]): void {
  for (const change of changes) {
    if (change.type === 'modify-file' || change.type === 'delete-file') {
      if (!existsSync(change.path)) {
        throw new CliError(
          `Cannot ${change.type}: file does not exist: ${change.path}`,
          {},
        );
      }
    }
    if (change.type === 'create-file') {
      if (existsSync(change.path)) {
        throw new CliError(
          `Cannot create file: already exists: ${change.path}`,
          {},
        );
      }
    }
  }
}

/**
 * Execute all changes in a plan atomically.
 */
export async function executeChanges(changes: Change[]): Promise<void> {
  auditChanges(changes);
  for (const change of changes) {
    if (change.type === 'delete-file') {
      await fsp.unlink(change.path);
    } else {
      await fsp.writeFile(change.path, change.content, 'utf-8');
    }
  }
}

/**
 * Execute undo changes to rollback a plan.
 */
export async function executeUndo(
  plan: TslorPlan,
  writer: (message: string) => void,
): Promise<void> {
  if (!plan.undo) {
    throw new CliError('Plan does not contain undo information', {});
  }

  writer('Rolling back changes...\n');

  for (const change of plan.undo) {
    if (change.type === 'delete-file') {
      if (existsSync(change.path)) {
        await fsp.unlink(change.path);
      }
    } else {
      await fsp.writeFile(change.path, change.content, 'utf-8');
    }
  }

  writer('✓ Changes rolled back\n');
}

/**
 * Archive a plan file after application.
 *
 * Uses copyFile + unlink instead of rename to handle cross-device (EXDEV)
 * scenarios where the plan file and working directory reside on different
 * filesystems (e.g., Docker volumes, network mounts, separate partitions).
 */
export async function archivePlan(planFile: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
  const appliedFile = join(dirname(planFile), `.applied-${timestamp}.json`);

  await fsp.copyFile(planFile, appliedFile);
  await fsp.unlink(planFile);

  return appliedFile;
}

/**
 * Generate a unified diff for a change.
 */
function generateDiff(change: Change, oldContent: string, cwd: string): string {
  const relativePath = relative(cwd, change.path);

  if (change.type === 'create-file') {
    return Diff.createPatch(
      relativePath,
      '',
      change.content,
      'original (does not exist)',
      'modified (new file)',
    );
  } else if (change.type === 'modify-file') {
    return Diff.createPatch(
      relativePath,
      oldContent,
      change.content,
      'original',
      'modified',
    );
  } else {
    return Diff.createPatch(
      relativePath,
      oldContent,
      '',
      'original',
      'modified (deleted)',
    );
  }
}

/**
 * Generate unified diffs for all changes in a plan.
 */
async function generatePlanDiff(plan: TslorPlan, cwd: string): Promise<string> {
  const diffs: string[] = [];

  for (const change of plan.changes) {
    let oldContent = '';

    // For modify/delete, read the current file content
    if (
      (change.type === 'modify-file' || change.type === 'delete-file') &&
      existsSync(change.path)
    ) {
      oldContent = await fsp.readFile(change.path, 'utf-8');
    }

    const diff = generateDiff(change, oldContent, cwd);
    if (diff) {
      diffs.push(diff);
    }
  }

  return diffs.join('\n');
}

function displayChangedFileNames(
  plan: TslorPlan,
  cwd: string,
  writer: (message: string) => void,
): void {
  writer('Files to be changed:\n');
  for (const change of plan.changes) {
    const symbol =
      change.type === 'create-file'
        ? '+'
        : change.type === 'delete-file'
          ? '-'
          : '~';
    const path = denormalizePath(change.path, cwd);
    writer(`  ${symbol} ${path}\n`);
  }
}

async function displayStatForChange(
  change: TslorPlan['changes'][number],
  cwd: string,
  writer: (message: string) => void,
): Promise<void> {
  const path = denormalizePath(change.path, cwd);

  if (change.type === 'create-file') {
    const lines = change.content.split('\n').length;
    writer(`  ${path} | ${lines} lines (new)\n`);
    return;
  }

  const oldContent = existsSync(change.path)
    ? await fsp.readFile(change.path, 'utf-8')
    : '';

  if (change.type === 'modify-file') {
    const newLines = change.content.split('\n').length;
    const oldLines = oldContent.split('\n').length;
    const delta = newLines - oldLines;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    writer(`  ${path} | ${deltaStr} lines\n`);
    return;
  }

  if (change.type === 'delete-file') {
    const lines = oldContent.split('\n').length;
    writer(`  ${path} | -${lines} lines (deleted)\n`);
  }
}

async function displayChangeStatistics(
  plan: TslorPlan,
  cwd: string,
  writer: (message: string) => void,
): Promise<void> {
  writer('Change statistics:\n');
  for (const change of plan.changes) {
    await displayStatForChange(change, cwd, writer);
  }
}

/**
 * Create an empty plan when no changes are needed.
 *
 * @param command - The command that generated the plan
 */
export function createEmptyPlan(command: string): TslorPlan {
  return {
    version: PLAN_VERSION,
    command,
    timestamp: new Date().toISOString(),
    sourceFiles: [],
    targetFiles: [],
    checksums: {},
    changes: [],
  };
}

/**
 * Display unified diff for a plan.
 */
export async function displayPlanDiff(
  plan: TslorPlan,
  options: { stats?: boolean; namesOnly?: boolean },
  cwd: string,
  writer: (message: string) => void,
): Promise<void> {
  if (options.namesOnly) {
    displayChangedFileNames(plan, cwd, writer);
    return;
  }
  if (options.stats) {
    await displayChangeStatistics(plan, cwd, writer);
    return;
  }
  const diff = await generatePlanDiff(plan, cwd);
  writer(diff);
}
