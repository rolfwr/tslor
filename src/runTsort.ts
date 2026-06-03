import { updateStorage } from "./indexing";
import { findGitRepoRoot, getTsconfigPathForFile } from "./project";
import { openStorage, Storage } from "./storage";
import { DebugOptions } from "./objstore";
import { denormalizePath } from "./pathUtils";
import { resolveCommandScope } from "./commandScope";
import { FileSystem } from "./filesystem";
import { assertDefined, getOrThrow } from "./invariant";

/**
 * Output interface for tsort results and errors.
 *
 * Allows callers to capture or redirect output instead of writing
 * directly to console, enabling testing without global state mutation.
 */
export interface TsortOutput {
  /** Write a module path to standard output */
  log: (msg: string) => void;
  /** Write an error message to standard error */
  error: (msg: string) => void;
}

/**
 * Options for configuring the tsort topological sort operation.
 */
export interface TsortOptions {
  /**
   * When true, filter dependencies so that cross-project imports are excluded.
   * Each module is checked against its own tsconfig rather than a single
   * representative.
   */
  projectScope?: boolean;
  /**
   * Repository root path. When omitted, `findGitRepoRoot` is called
   * to derive it from the input paths.
   */
  repoRoot?: string;
  /**
   * Output handler for module paths and error messages.
   * Defaults to `console.log` / `console.error` when omitted.
   */
  output?: TsortOutput;
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
 * Topologically sort modules by their import dependencies.
 *
 * Given a list of TypeScript module paths, outputs them in dependency order
 * (dependencies before dependents). Only considers import relationships
 * between the provided modules, ignoring external dependencies.
 *
 * Uses Kahn's algorithm for deterministic output order.
 */
export async function runTsort(
  modulePaths: string[],
  options: TsortOptions,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
): Promise<void> {
  if (modulePaths.length === 0) {
    return;
  }

  const output = options.output ?? {
    log: (msg: string) => console.log(msg),
    error: (msg: string) => console.error(msg),
  };

  /*
    Resolve hybrid path input: files are normalized to absolute paths,
    directories are expanded to all TypeScript modules within them.
  */
  const moduleSet = await resolveCommandScope(modulePaths, fileSystem);

  if (moduleSet.size === 0) {
    return;
  }

  // Find git repo root and open storage
  const tsPath = moduleSet.values().next().value;
  assertDefined(tsPath, 'moduleSet is non-empty but yielded no value');
  const repoRoot = options.repoRoot ?? findGitRepoRoot(tsPath);

  const db = options.storage ?? openStorage(debugOptions, false);
  if (!options.storage) {
    await updateStorage(repoRoot, db, true, fileSystem);
  }

  /*
    When project-scope is enabled, resolve each module's tsconfig so that
    cross-project imports are filtered per-module rather than against a
    single representative's tsconfig.
  */
  let moduleTsconfigMap: Map<string, string> | null = null;
  if (options.projectScope === true) {
    const filePaths = Array.from(moduleSet);
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
    moduleTsconfigMap = new Map(entries);
  }

  // Build the dependency graph considering only the input modules
  const { graph, reverseGraph } = buildDependencyGraph(db, moduleSet, moduleTsconfigMap);

  // Perform topological sort using Kahn's algorithm
  const sorted = topologicalSort(moduleSet, graph, reverseGraph);

  if (sorted === null) {
    // Cycle detected
    const cycleNodes = findCycleNodes(moduleSet, reverseGraph);
    const cwd = process.cwd();
    const cyclePaths = [...cycleNodes].map((node) => denormalizePath(node, cwd));
    throw new Error(
      `tsort: cycle detected among ${cyclePaths.length} module${cyclePaths.length === 1 ? '' : 's'}:\n` +
      cyclePaths.map((p) => `  ${p}`).join('\n')
    );
  }

  // Output modules in sorted order (dependencies first)
  for (const modulePath of sorted) {
    output.log(modulePath);
  }

  // Only persist storage that we created ourselves
  if (!options.storage) {
    db.save();
  }
}

/**
 * Build a dependency graph for the given set of modules.
 *
 * Graph edges go from dependency to dependent (exporter -> importer).
 * This way Kahn's algorithm processes zero-in-degree nodes (no dependencies
 * within the set) first, producing dependency-first output.
 *
 * @param moduleTsconfigMap Per-module tsconfig map for project-scope filtering,
 *   or null when project-scope is disabled.
 * @returns graph: Map of module -> modules that import it (within the set)
 * @returns reverseGraph: Map of module -> modules it imports (within the set)
 */
function buildDependencyGraph(
  db: Storage,
  moduleSet: Set<string>,
  moduleTsconfigMap: Map<string, string> | null
): { graph: Map<string, Set<string>>; reverseGraph: Map<string, Set<string>> } {
  const graph = new Map<string, Set<string>>();
  const reverseGraph = new Map<string, Set<string>>();

  // Initialize all nodes
  for (const modulePath of moduleSet) {
    graph.set(modulePath, new Set());
    reverseGraph.set(modulePath, new Set());
  }

  // Build edges
  for (const modulePath of moduleSet) {
    buildEdgesForModule(modulePath, db, moduleSet, moduleTsconfigMap, graph, reverseGraph);
  }

  return { graph, reverseGraph };
}

function buildEdgesForModule(
  modulePath: string,
  db: Storage,
  moduleSet: Set<string>,
  moduleTsconfigMap: Map<string, string> | null,
  graph: Map<string, Set<string>>,
  reverseGraph: Map<string, Set<string>>
): void {
  const exporters = db.getExporterPathsOfImport(modulePath);

  for (const exporter of exporters) {
    if (shouldSkipExporter(modulePath, exporter, moduleTsconfigMap)) {
      continue;
    }
    addEdgeIfInScope(modulePath, exporter.path, moduleSet, graph, reverseGraph);
  }
}

function shouldSkipExporter(
  modulePath: string,
  exporter: { path: string; tsconfig: string },
  moduleTsconfigMap: Map<string, string> | null
): boolean {
  if (moduleTsconfigMap === null) {
    return false;
  }
  const moduleTsconfig = moduleTsconfigMap.get(modulePath);
  if (moduleTsconfig === undefined) {
    return true;
  }
  return moduleTsconfig !== exporter.tsconfig;
}

function addEdgeIfInScope(
  modulePath: string,
  exporterPath: string,
  moduleSet: Set<string>,
  graph: Map<string, Set<string>>,
  reverseGraph: Map<string, Set<string>>
): void {
  if (!moduleSet.has(exporterPath)) {
    return;
  }
  getOrThrow(graph, exporterPath, 'exporterPath not in graph').add(modulePath);
  getOrThrow(reverseGraph, modulePath, 'modulePath not in reverseGraph').add(exporterPath);
}

function insertSorted(queue: string[], item: string): void {
  const insertIndex = queue.findIndex(q => q > item);
  if (insertIndex === -1) {
    queue.push(item);
  } else {
    queue.splice(insertIndex, 0, item);
  }
}

/**
 * Perform topological sort using Kahn's algorithm.
 *
 * Returns modules in dependency order (dependencies first), or null if a cycle is detected.
 */
function topologicalSort(
  moduleSet: Set<string>,
  graph: Map<string, Set<string>>,
  reverseGraph: Map<string, Set<string>>
): string[] | null {
  const inDegree = computeInDegree(moduleSet, reverseGraph);
  const queue = initializeQueue(moduleSet, inDegree);
  queue.sort();
  const result = processQueue(queue, graph, inDegree);

  if (result.length < moduleSet.size) {
    return null;
  }

  return result;
}

function computeInDegree(
  moduleSet: Set<string>,
  reverseGraph: Map<string, Set<string>>
): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const modulePath of moduleSet) {
    inDegree.set(modulePath, getOrThrow(reverseGraph, modulePath, 'modulePath not in reverseGraph').size);
  }
  return inDegree;
}

function initializeQueue(
  moduleSet: Set<string>,
  inDegree: Map<string, number>
): string[] {
  const queue: string[] = [];
  for (const modulePath of moduleSet) {
    if (inDegree.get(modulePath) === 0) {
      queue.push(modulePath);
    }
  }
  return queue;
}

function processQueue(
  queue: string[],
  graph: Map<string, Set<string>>,
  inDegree: Map<string, number>
): string[] {
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    result.push(current);
    processDependents(current, graph, inDegree, queue);
  }

  return result;
}

function processDependents(
  current: string,
  graph: Map<string, Set<string>>,
  inDegree: Map<string, number>,
  queue: string[]
): void {
  for (const dependent of getOrThrow(graph, current, 'current not in graph')) {
    const newInDegree = getOrThrow(inDegree, dependent, 'dependent not in inDegree') - 1;
    inDegree.set(dependent, newInDegree);
    if (newInDegree === 0) {
      insertSorted(queue, dependent);
    }
  }
}

function markPathCycleNodes(
  cycleNodes: Set<string>,
  path: string[],
  cycleAnchor: string,
  extraNode: string,
  currentNode: string
): void {
  const cycleStart = path.indexOf(cycleAnchor);
  if (cycleStart !== -1) {
    for (let i = cycleStart; i < path.length; i++) {
      const node = path.at(i);
      if (node === undefined) {
        continue;
      }
      cycleNodes.add(node);
    }
  }
  cycleNodes.add(extraNode);
  cycleNodes.add(currentNode);
}

function dfsFindCycles(
  node: string,
  path: string[],
  visited: Set<string>,
  recStack: Set<string>,
  cycleNodes: Set<string>,
  graph: Map<string, Set<string>>
): boolean {
  visited.add(node);
  recStack.add(node);

  for (const neighbor of graph.get(node) || []) {
    if (!visited.has(neighbor)) {
      if (dfsFindCycles(neighbor, [...path, neighbor], visited, recStack, cycleNodes, graph)) {
        markPathCycleNodes(cycleNodes, path, neighbor, node, node);
        return true;
      }
    } else if (recStack.has(neighbor)) {
      markPathCycleNodes(cycleNodes, path, neighbor, neighbor, node);
      return true;
    }
  }

  recStack.delete(node);
  return false;
}

/**
 * Find nodes that are part of cycles for error reporting.
 */
function findCycleNodes(
  moduleSet: Set<string>,
  graph: Map<string, Set<string>>
): Set<string> {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycleNodes = new Set<string>();

  for (const node of moduleSet) {
    if (!visited.has(node)) {
      dfsFindCycles(node, [node], visited, recStack, cycleNodes, graph);
    }
  }

  return cycleNodes;
}
