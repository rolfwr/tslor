import { findGitRepoRoot, getTsconfigPathForFile } from "./project";
import { openStorage, Storage } from "./storage";
import { updateStorage } from "./indexing";
import { DebugOptions } from "./objstore";
import { denormalizePath } from "./pathUtils";
import { resolveCommandScope } from "./commandScope";
import { FileSystem } from "./filesystem";
import { assertDefined } from "./invariant";

/**
 * A group of modules sharing the same normalized import set.
 */
interface ImportGroup {
  /** Sorted resolved import paths that all members share */
  imports: string[];
  /** Module paths belonging to this group */
  members: string[];
  /** Score: members.length * imports.length */
  score: number;
}

/**
 * Options for configuring the import-groups operation.
 */
export interface ImportGroupsOptions {
  /** Only consider imports within the same tsconfig project (default: false) */
  projectScope?: boolean;
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
  fileSystem: FileSystem
): Promise<void> {
  if (inputPaths.length === 0) {
    console.log("No paths provided.");
    return;
  }

  const cwd = process.cwd();
  const moduleSet = await resolveCommandScope(inputPaths, fileSystem);

  if (moduleSet.size === 0) {
    console.log("No TypeScript files found in the given paths.");
    return;
  }

  const entryPath = moduleSet.values().next().value;
  assertDefined(entryPath, "moduleSet is non-empty (guarded above)");
  const repoRoot = findGitRepoRoot(entryPath);

  const db = openStorage(debugOptions, { verbose: false, inMemory: false });
  await updateStorage(repoRoot, db, true, fileSystem, (msg) => console.log(msg));

  try {
    const filePaths = Array.from(moduleSet);
    const moduleTsconfigMap = await resolveModuleTsconfigs(
      filePaths,
      repoRoot,
      options,
      fileSystem
    );

    const groups = buildImportGroups(db, filePaths, moduleTsconfigMap);
    renderGroups(groups, cwd);
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
  fileSystem: FileSystem
): Promise<Map<string, string> | null> {
  if (options.projectScope !== true) {
    return null;
  }

  const tsconfigs = await Promise.all(
    filePaths.map((path) => getTsconfigPathForFile(repoRoot, path, fileSystem))
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
 * Exposed for testing without I/O side effects.
 */
export function buildImportGroups(
  db: Storage,
  filePaths: string[],
  moduleTsconfigMap: Map<string, string> | null
): ImportGroup[] {
  const groups = collectImportGroups(db, filePaths, moduleTsconfigMap);
  return scoreAndSortGroups(groups);
}

/**
 * Iterate over modules, compute their normalized import sets, and
 * collect them into groups keyed by the sorted import paths.
 *
 * Modules with zero imports are excluded. Singleton groups are excluded.
 */
function collectImportGroups(
  db: Storage,
  filePaths: string[],
  moduleTsconfigMap: Map<string, string> | null
): Map<string, ImportGroup> {
  const groups = new Map<string, ImportGroup>();

  for (const modulePath of filePaths) {
    const importPaths = getFilteredImports(
      db,
      modulePath,
      moduleTsconfigMap
    );

    if (importPaths.length === 0) {
      continue;
    }

    const key = importPaths.join("|");
    let group = groups.get(key);
    if (!group) {
      group = { imports: importPaths, members: [], score: 0 };
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
  moduleTsconfigMap: Map<string, string> | null
): string[] {
  const exporters = db.getExporterPathsOfImport(modulePath);

  const filteredExporters = filterByProjectScope(
    exporters,
    modulePath,
    moduleTsconfigMap
  );

  return [...new Set(filteredExporters.map((e) => e.path))].sort();
}

/**
 * Filter exporters by project scope. When moduleTsconfigMap is null,
 * all exporters are kept. Otherwise, only exporters whose tsconfig
 * matches the importing module's tsconfig are retained.
 */
function filterByProjectScope(
  exporters: { path: string; tsconfig: string }[],
  modulePath: string,
  moduleTsconfigMap: Map<string, string> | null
): { path: string; tsconfig: string }[] {
  if (moduleTsconfigMap === null) {
    return exporters;
  }

  const moduleTsconfig = moduleTsconfigMap.get(modulePath);
  if (moduleTsconfig === undefined) {
    return [];
  }

  return exporters.filter((exporter) => exporter.tsconfig === moduleTsconfig);
}

/**
 * Score groups (members * imports), filter out singletons, sort descending
 * by score with lexicographic tie-breaking by hash key.
 */
function scoreAndSortGroups(
  groups: Map<string, ImportGroup>
): ImportGroup[] {
  const scored: ImportGroup[] = [];

  for (const group of groups.values()) {
    if (group.members.length < 2) {
      continue;
    }

    group.members.sort();
    group.score = group.members.length * group.imports.length;
    scored.push(group);
  }

  scored.sort(compareGroups);
  return scored;
}

/**
 * Compare two groups: descending by score, ascending lexicographic by key.
 */
function compareGroups(a: ImportGroup, b: ImportGroup): number {
  const scoreDiff = b.score - a.score;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  const keyA = a.imports.join("|");
  const keyB = b.imports.join("|");
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/**
 * Render groups as structured text blocks to stdout.
 */
function renderGroups(groups: ImportGroup[], cwd: string): void {
  for (const group of groups) {
    const memberCount = group.members.length;
    const importCount = group.imports.length;
    console.log(
      `Group (score ${group.score}): ${memberCount} module${memberCount === 1 ? "" : "s"} share ${importCount} import${importCount === 1 ? "" : "s"}`
    );
    console.log(
      "  imports:",
      group.imports.map((p) => denormalizePath(p, cwd)).join(", ")
    );
    console.log("  members:");
    for (const member of group.members) {
      console.log("    " + denormalizePath(member, cwd));
    }
  }
}
