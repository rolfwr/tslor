import { updateStorage } from "./indexing";
import { findGitRepoRoot, getTsconfigPathForFile } from "./project";
import { openStorage, Storage } from "./storage";
import { DebugOptions } from "./objstore";
import { resolveCommandScope } from "./commandScope";
import { FileSystem } from "./filesystem";
import { assertDefined } from "./invariant";

/**
 * Output interface for dependencies results.
 *
 * Allows callers to capture or redirect output instead of writing
 * directly to console, enabling testing without global state mutation.
 */
export interface DependenciesOutput {
  /** Write a module path to standard output */
  log: (msg: string) => void;
}

/**
 * Options for configuring the dependencies operation.
 */
export interface DependenciesOptions {
  /** Only list modules within the same tsconfig project */
  projectScope?: boolean;
  /**
   * Repository root path. When omitted, `findGitRepoRoot` is called
   * to derive it from the input paths.
   */
  repoRoot?: string;
  /**
   * Output handler for module paths. Defaults to `console.log` when omitted.
   */
  output?: DependenciesOutput;
  /**
   * Pre-configured storage instance. When omitted, `openStorage` is
   * called to create one from disk, `updateStorage` is invoked to
   * ensure freshness, and `db.save()` is called on completion.
   * When provided, the caller is responsible for ensuring the storage
   * is up-to-date and for persisting any changes.
   */
  storage?: Storage;
}

/**
 * List transitive module imports for the given module paths.
 *
 * Accepts hybrid path input: files are normalized to absolute paths,
 * directories are expanded to all TypeScript modules within them.
 */
export async function runDependencies(
  modulePaths: string[],
  options: DependenciesOptions,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
): Promise<void> {
  if (modulePaths.length === 0) {
    throw new Error('No module paths provided');
  }

  const output = options.output ?? {
    log: (msg: string) => console.log(msg),
  };

  /*
    Resolve hybrid path input: files are normalized to absolute paths,
    directories are expanded to all TypeScript modules within them.
  */
  const moduleSet = await resolveCommandScope(modulePaths, fileSystem);

  if (moduleSet.size === 0) {
    throw new Error('No module paths provided');
  }

  // Find git repo root and open storage
  const tsPath = moduleSet.values().next().value;
  assertDefined(tsPath, 'moduleSet is non-empty but yielded no value');
  const repoRoot = options.repoRoot ?? findGitRepoRoot(tsPath);

  const db = options.storage ?? openStorage(debugOptions, false);
  if (!options.storage) {
    await updateStorage(repoRoot, db, true, fileSystem);
  }

  // Get tsconfig path for project scope filtering if needed
  const tsconfigPath = options.projectScope
    ? await getTsconfigPathForFile(repoRoot, tsPath, fileSystem)
    : null;

  // Dump dependencies for each module
  const seen = new Set<string>();
  for (const path of moduleSet) {
    dumpDependenciesFor(db, path, seen, tsconfigPath, output);
  }

  // Only persist storage that we created ourselves
  if (!options.storage) {
    db.save();
  }
}

function dumpDependenciesFor(
  db: Storage,
  tsPath: string,
  seen: Set<string>,
  tsconfigPathScope: string | null,
  output: DependenciesOutput
): void {
  if (seen.has(tsPath)) {
    return;
  }
  seen.add(tsPath);

  const exporters = db.getExporterPathsOfImport(tsPath);
  for (const exporter of exporters) {
    if (tsconfigPathScope && tsconfigPathScope !== exporter.tsconfig) {
      continue;
    }
    dumpDependenciesFor(db, exporter.path, seen, tsconfigPathScope, output);
  }

  output.log(tsPath);
}
