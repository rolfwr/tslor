import { findGitRepoRoot, getTsconfigPathForFile } from './project';
import { openStorage, ExporterPath, Storage } from './storage';
import { updateStorage } from './indexing';
import { DebugOptions } from './objstore';
import { denormalizePath } from './pathUtils';
import { resolveCommandScope } from './commandScope';
import { FileSystem } from './filesystem';
import { assertDefined } from './invariant';

/**
 * A group of modules sharing the same normalized import set.
 */
interface ImportGroup {
  /** Sorted resolved import paths that all members share */
  imports: string[];
  /** Module paths belonging to this group */
  members: string[];
}

/**
 * Options for configuring the import-groups operation.
 */
export interface ImportGroupsOptions {
  /** Only consider imports within the same tsconfig project (default: false) */
  projectScope?: boolean;
  /** When true, delete the existing index database before opening storage */
  fresh?: boolean;
  /**
   * Callback for indexing progress messages. Tests can supply a stub to
   * suppress or capture output.
   */
  writer: (message: string) => void;
  /** Working directory for path denormalization */
  cwd: string;
}

/**
 * Group TypeScript modules by their normalized import set, score the groups,
 * and output structured text blocks sorted by descending score.
 *
 * Modules with zero imports are excluded. Groups with fewer than 2 members
 * are excluded. Two modules belong to the same group when their resolved
 * dependency sets match after normalization (alias normalization is handled
 * by the storage layer which resolves all import specifiers to canonical paths).
 */
export async function runImportGroups(
  inputPaths: string[],
  options: ImportGroupsOptions,
  debugOptions: DebugOptions,
  fileSystem: FileSystem,
): Promise<void> {
  if (inputPaths.length === 0) {
    console.log('No paths provided.');
    return;
  }

  const moduleSet = await resolveCommandScope(inputPaths, fileSystem);

  if (moduleSet.size === 0) {
    console.log('No TypeScript files found in the given paths.');
    return;
  }

  const entryPath = moduleSet.values().next().value;
  assertDefined(entryPath, 'moduleSet is non-empty (guarded above)');
  const repoRoot = findGitRepoRoot(entryPath);

  const db = openStorage(debugOptions, {
    verbose: false,
    fresh: options.fresh ?? false,
    basePath: repoRoot,
    inMemory: false,
  });
  await updateStorage(repoRoot, db, true, fileSystem, options.writer);

  try {
    const filePaths = Array.from(moduleSet);
    const moduleTsconfigMap = await resolveModuleTsconfigs(
      filePaths,
      repoRoot,
      options,
      fileSystem,
    );

    const groups = buildImportGroups(db, filePaths, moduleTsconfigMap);
    renderGroups(groups, options.cwd);
  } finally {
    db.save();
  }
}

/**
 * Resolve per-module tsconfig map when project-scope is enabled.
 * Returns null when project-scope is disabled.
 */
async function resolveModuleTsconfigs(
  filePaths: string[],
  repoRoot: string,
  options: ImportGroupsOptions,
  fileSystem: FileSystem,
): Promise<Map<string, string> | null> {
  if (options.projectScope !== true) {
    return null;
  }

  const tsconfigs = await Promise.all(
    filePaths.map((path) => getTsconfigPathForFile(repoRoot, path, fileSystem)),
  );
  const entries: [string, string][] = filePaths.flatMap((path, i) => {
    const tsconfig = tsconfigs[i];
    if (tsconfig == null) {
      return [];
    }
    return [[path, tsconfig]];
  });
  return new Map(entries);
}

/**
 * Build and score import groups from storage data.
 *
 * Groups modules by their normalized import set. Modules with zero imports
 * and groups with fewer than 2 members are excluded. Each group is scored
 * as members.length * imports.length. Results are sorted by descending score
 * with lexicographic tie-breaking by import key.
 */
export function buildImportGroups(
  db: Storage,
  filePaths: string[],
  moduleTsconfigMap: Map<string, string> | null,
): { group: ImportGroup; score: number }[] {
  const groups = collectImportGroups(db, filePaths, moduleTsconfigMap);
  return scoreAndSortGroups(groups);
}

/**
 * Iterate over modules, compute their normalized import sets, and
 * collect them into groups keyed by the sorted import paths.
 *
 * Modules with zero imports are excluded.
 */
function collectImportGroups(
  db: Storage,
  filePaths: string[],
  moduleTsconfigMap: Map<string, string> | null,
): Map<string, ImportGroup> {
  const groups = new Map<string, ImportGroup>();

  for (const modulePath of filePaths) {
    const importPaths = getFilteredImports(db, modulePath, moduleTsconfigMap);

    if (importPaths.length === 0) {
      continue;
    }

    const key = importPaths.join('|');
    let group = groups.get(key);
    if (!group) {
      group = { imports: importPaths, members: [] };
      groups.set(key, group);
    }
    group.members.push(modulePath);
  }

  return groups;
}

/**
 * Get the deduplicated, sorted list of resolved import paths for a module,
 * optionally filtered by project scope.
 */
function getFilteredImports(
  db: Storage,
  modulePath: string,
  moduleTsconfigMap: Map<string, string> | null,
): string[] {
  const exporters = db.getExporterPathsOfImport(modulePath);

  const filteredExporters =
    moduleTsconfigMap !== null
      ? filterExportersByProjectScope(exporters, modulePath, moduleTsconfigMap)
      : exporters;

  return [...new Set(filteredExporters.map((e) => e.path))].sort();
}

/**
 * Filter exporters by project scope.
 *
 * Only exporters whose tsconfig matches the importing module's tsconfig
 * are retained. Modules without a tsconfig entry are kept with all their
 * exporters (can't filter when project boundary is unknown).
 */
function filterExportersByProjectScope(
  exporters: ExporterPath[],
  modulePath: string,
  moduleTsconfigMap: Map<string, string>,
): ExporterPath[] {
  const moduleTsconfig = moduleTsconfigMap.get(modulePath);
  /*
    Module has no tsconfig (not covered by any project). Can't filter,
    so include all dependencies rather than silently dropping them.
  */
  if (moduleTsconfig === undefined) {
    return exporters;
  }

  return exporters.filter((exporter) => exporter.tsconfig === moduleTsconfig);
}

/**
 * Score groups (members * imports), filter out singletons, sort descending
 * by score with lexicographic tie-breaking by import key.
 */
function scoreAndSortGroups(
  groups: Map<string, ImportGroup>,
): { group: ImportGroup; score: number }[] {
  const scored: { key: string; group: ImportGroup; score: number }[] = [];

  for (const [key, group] of groups.entries()) {
    if (group.members.length < 2) {
      continue;
    }

    group.members.sort();
    scored.push({
      key,
      group,
      score: group.members.length * group.imports.length,
    });
  }

  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return scored.map(({ group, score }) => ({ group, score }));
}

/**
 * Render groups as structured text blocks to stdout.
 */
function renderGroups(
  groups: { group: ImportGroup; score: number }[],
  cwd: string,
): void {
  if (groups.length === 0) {
    console.log('No import groups found.');
    return;
  }

  for (const { group, score } of groups) {
    const memberCount = group.members.length;
    const importCount = group.imports.length;
    console.log(
      `Group (score ${score}): ${memberCount} module${memberCount === 1 ? '' : 's'} share ${importCount} import${importCount === 1 ? '' : 's'}`,
    );
    console.log(
      '  imports:',
      group.imports.map((p) => denormalizePath(p, cwd)).join(', '),
    );
    console.log('  members:');
    for (const member of group.members) {
      console.log('    ' + denormalizePath(member, cwd));
    }
  }
}
