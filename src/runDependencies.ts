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
 * List reverse dependencies: for each input module, output the module itself
 * and all modules that transitively import it (direct and indirect importers).
 *
 * Accepts hybrid path input: files are normalized to absolute paths,
 * directories are expanded to all TypeScript modules within them.
 *
 * Output is written via the `output` handler in `options` (defaults to
 * `console.log`). Each module path is printed exactly once, even if it
 * appears as a transitive dependency of multiple input modules.
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
    throw new Error('Input paths resolved to no TypeScript modules');
  }

  /*
    Extract one representative path from the set so we can resolve the
    repo root and tsconfig scope. The set is guaranteed non-empty by the
    guard above; assertDefined narrows the type and provides a runtime
    safety net.
  */
  const tsPathValue = moduleSet.values().next().value;
  assertDefined(tsPathValue, 'moduleSet is guaranteed non-empty by guard above');

  const repoRoot = options.repoRoot ?? findGitRepoRoot(tsPathValue);

  /*
    Open storage before the try block so `db` is definitely assigned.
    The try/finally below only covers the read-phase and save cleanup.
  */
  const db = options.storage ?? openStorage(debugOptions, true);
  if (!options.storage) {
    await updateStorage(repoRoot, db, true, fileSystem);
  }

  try {
    const tsconfigPath = options.projectScope
      ? await getTsconfigPathForFile(repoRoot, tsPathValue, fileSystem)
      : null;
    const seen = new Set<string>();
    for (const path of moduleSet) {
      dumpDependenciesFor(db, path, seen, tsconfigPath, output);
    }
  } finally {
    if (!options.storage) {
      db.save();
    }
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

  const reverseDeps = db.getReverseDependencies(tsPath);
  for (const dep of reverseDeps) {
    if (tsconfigPathScope && tsconfigPathScope !== dep.tsconfig) {
      continue;
    }
    dumpDependenciesFor(db, dep.path, seen, tsconfigPathScope, output);
  }

  output.log(tsPath);
}
