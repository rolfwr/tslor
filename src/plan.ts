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
import { relative } from 'path';

export const PLAN_FILE_NAME = '.tslor-plan.json';
export const PLAN_VERSION = '1.0.0';

/**
 * A TSLOR refactoring plan that can be proposed, reviewed, and applied.
 */
export interface TslorPlan {
  version: string;           // Plan format version
  command: string;           // Command that created this plan (e.g., "split")
  timestamp: string;         // ISO 8601 timestamp when proposed
  sourceFiles: string[];     // Files being modified
  targetFiles: string[];     // Files being created
  
  // Checksums to detect changes since proposal
  checksums: {
    [filePath: string]: string;  // SHA256 of file content
  };
  
  // The actual changes to apply
  changes: Change[];
  
  // Optional: Undo information for rollback
  undo?: Change[];
}

/**
 * Types of changes that can be applied to files
 */
export type Change =
  | CreateFileChange
  | ModifyFileChange
  | DeleteFileChange;

export interface CreateFileChange {
  type: 'create-file';
  path: string;
  content: string;
}

export interface ModifyFileChange {
  type: 'modify-file';
  path: string;
  content: string;
  originalChecksum: string;  // To verify file hasn't changed
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
export async function writePlan(plan: TslorPlan, planFile: string = PLAN_FILE_NAME): Promise<void> {
  const planJson = JSON.stringify(plan, null, 2);
  await fsp.writeFile(planFile, planJson, 'utf-8');
}

/**
 * Read a plan from a file.
 */
export async function readPlan(planFile: string = PLAN_FILE_NAME): Promise<TslorPlan> {
  if (!existsSync(planFile)) {
    throw new Error(`Plan file does not exist: ${planFile}`);
  }
  
  const planJson = await fsp.readFile(planFile, 'utf-8');
  const plan = JSON.parse(planJson) as TslorPlan;
  
  validatePlanFormat(plan);
  
  return plan;
}

/**
 * Validate that a plan has the correct format.
 */
export function validatePlanFormat(plan: TslorPlan): void {
  if (!plan.version) {
    throw new Error('Plan missing version field');
  }
  
  if (!plan.command) {
    throw new Error('Plan missing command field');
  }
  
  if (!plan.timestamp) {
    throw new Error('Plan missing timestamp field');
  }
  
  if (!Array.isArray(plan.sourceFiles)) {
    throw new Error('Plan missing sourceFiles array');
  }
  
  if (!Array.isArray(plan.targetFiles)) {
    throw new Error('Plan missing targetFiles array');
  }
  
  if (!plan.checksums || typeof plan.checksums !== 'object') {
    throw new Error('Plan missing checksums object');
  }
  
  if (!Array.isArray(plan.changes)) {
    throw new Error('Plan missing changes array');
  }
}

/**
 * Validate that files haven't changed since plan was created.
 */
export async function validateChecksums(plan: TslorPlan, force: boolean = false): Promise<void> {
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
    throw new Error(
      `The following files no longer exist:\n` +
      missing.map(f => `  - ${f}`).join('\n') +
      `\n\nPlan cannot be applied.`
    );
  }
  
  if (mismatches.length > 0 && !force) {
    throw new Error(
      `The following files have changed since plan was created:\n` +
      mismatches.map(f => `  - ${f}`).join('\n') +
      `\n\nPlease create a new plan or use --force to apply anyway.`
    );
  }
  
  if (mismatches.length > 0 && force) {
    console.warn('Warning: Applying plan despite checksum mismatches (--force specified)');
    for (const file of mismatches) {
      console.warn(`  - ${file}`);
    }
  }
}

/**
 * Display a human-readable preview of the plan.
 */
export async function displayPlan(plan: TslorPlan, options: { noDiff?: boolean } = {}): Promise<void> {
  console.log('\n=== PROPOSED CHANGES ===');
  console.log(`Command: ${plan.command}`);
  console.log(`Proposed at: ${plan.timestamp}`);
  console.log('');
  
  // Group changes by type
  const creates = plan.changes.filter(c => c.type === 'create-file') as CreateFileChange[];
  const modifies = plan.changes.filter(c => c.type === 'modify-file') as ModifyFileChange[];
  const deletes = plan.changes.filter(c => c.type === 'delete-file') as DeleteFileChange[];
  
  if (creates.length > 0) {
    console.log('Files to create:');
    for (const change of creates) {
      const lines = change.content.split('\n').length;
      console.log(`  + ${relative(process.cwd(), change.path)} (${lines} lines)`);
    }
    console.log('');
  }
  
  if (modifies.length > 0) {
    console.log('Files to modify:');
    for (const change of modifies) {
      const lines = change.content.split('\n').length;
      console.log(`  ~ ${relative(process.cwd(), change.path)} (${lines} lines)`);
    }
    console.log('');
  }
  
  if (deletes.length > 0) {
    console.log('Files to delete:');
    for (const change of deletes) {
      console.log(`  - ${relative(process.cwd(), change.path)}`);
    }
    console.log('');
  }
  
  console.log(`Total changes: ${plan.changes.length}`);
  console.log('');
  
  // Show unified diff (unless disabled)
  if (!options.noDiff) {
    console.log('=== DIFF ===');
    const diff = await generatePlanDiff(plan);
    console.log(diff);
    console.log('');
  }
  
  console.log(`Plan written to: ${PLAN_FILE_NAME}`);
  console.log(`To apply: tslor apply`);
  console.log(`To see diff: tslor diff`);
  console.log('=== END PROPOSED CHANGES ===\n');
}

/**
 * Execute all changes in a plan atomically.
 */
export async function executeChanges(changes: Change[]): Promise<void> {
  // First, validate that all changes can be applied
  for (const change of changes) {
    if (change.type === 'modify-file' || change.type === 'delete-file') {
      if (!existsSync(change.path)) {
        throw new Error(`Cannot ${change.type}: file does not exist: ${change.path}`);
      }
    }
    
    if (change.type === 'create-file') {
      if (existsSync(change.path)) {
        throw new Error(`Cannot create file: already exists: ${change.path}`);
      }
    }
  }
  
  // Execute all changes
  for (const change of changes) {
    switch (change.type) {
      case 'create-file':
        await fsp.writeFile(change.path, change.content, 'utf-8');
        break;
        
      case 'modify-file':
        await fsp.writeFile(change.path, change.content, 'utf-8');
        break;
        
      case 'delete-file':
        await fsp.unlink(change.path);
        break;
    }
  }
}

/**
 * Execute undo changes to rollback a plan.
 */
export async function executeUndo(plan: TslorPlan): Promise<void> {
  if (!plan.undo) {
    throw new Error('Plan does not contain undo information');
  }
  
  console.log('Rolling back changes...');
  
  // Execute undo changes
  for (const change of plan.undo) {
    switch (change.type) {
      case 'create-file':
        await fsp.writeFile(change.path, change.content, 'utf-8');
        break;
        
      case 'modify-file':
        await fsp.writeFile(change.path, change.content, 'utf-8');
        break;
        
      case 'delete-file':
        if (existsSync(change.path)) {
          await fsp.unlink(change.path);
        }
        break;
    }
  }
  
  console.log('✓ Changes rolled back');
}

/**
 * Archive a plan file after application.
 */
export async function archivePlan(planFile: string = PLAN_FILE_NAME): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
  const appliedFile = `.applied-${timestamp}.json`;
  
  await fsp.rename(planFile, appliedFile);
  
  return appliedFile;
}

/**
 * Generate a unified diff for a change.
 */
export function generateDiff(change: Change, oldContent?: string): string {
  const cwd = process.cwd();
  const relativePath = relative(cwd, change.path);
  
  if (change.type === 'create-file') {
    // Show as creating new file
    const patch = Diff.createPatch(
      relativePath,
      '',
      change.content,
      'original (does not exist)',
      'modified (new file)'
    );
    return patch;
  } else if (change.type === 'modify-file') {
    // Show diff between original and modified
    const original = oldContent || '';
    const patch = Diff.createPatch(
      relativePath,
      original,
      change.content,
      'original',
      'modified'
    );
    return patch;
  } else if (change.type === 'delete-file') {
    // Show as deleting file
    const original = oldContent || '';
    const patch = Diff.createPatch(
      relativePath,
      original,
      '',
      'original',
      'modified (deleted)'
    );
    return patch;
  }
  
  return '';
}

/**
 * Generate unified diffs for all changes in a plan.
 */
export async function generatePlanDiff(plan: TslorPlan): Promise<string> {
  const diffs: string[] = [];
  
  for (const change of plan.changes) {
    let oldContent = '';
    
    // For modify/delete, read the current file content
    if ((change.type === 'modify-file' || change.type === 'delete-file') && existsSync(change.path)) {
      oldContent = await fsp.readFile(change.path, 'utf-8');
    }
    
    const diff = generateDiff(change, oldContent);
    if (diff) {
      diffs.push(diff);
    }
  }
  
  return diffs.join('\n');
}

/**
 * Display unified diff for a plan.
 */
export async function displayPlanDiff(plan: TslorPlan, options: { stats?: boolean; namesOnly?: boolean } = {}): Promise<void> {
  if (options.namesOnly) {
    // Just show file names
    console.log('Files to be changed:');
    for (const change of plan.changes) {
      const symbol = change.type === 'create-file' ? '+' : change.type === 'delete-file' ? '-' : '~';
      const relativePath = relative(process.cwd(), change.path);
      console.log(`  ${symbol} ${relativePath}`);
    }
    return;
  }
  
  if (options.stats) {
    // Show statistics
    console.log('Change statistics:');
    for (const change of plan.changes) {
      const relativePath = relative(process.cwd(), change.path);
      if (change.type === 'create-file') {
        const lines = change.content.split('\n').length;
        console.log(`  ${relativePath} | ${lines} lines (new)`);
      } else if (change.type === 'modify-file') {
        const oldContent = existsSync(change.path) ? await fsp.readFile(change.path, 'utf-8') : '';
        const oldLines = oldContent.split('\n').length;
        const newLines = change.content.split('\n').length;
        const delta = newLines - oldLines;
        const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
        console.log(`  ${relativePath} | ${deltaStr} lines`);
      } else if (change.type === 'delete-file') {
        const oldContent = existsSync(change.path) ? await fsp.readFile(change.path, 'utf-8') : '';
        const lines = oldContent.split('\n').length;
        console.log(`  ${relativePath} | -${lines} lines (deleted)`);
      }
    }
    return;
  }
  
  // Show full unified diff
  const diff = await generatePlanDiff(plan);
  console.log(diff);
}
