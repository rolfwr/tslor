import { updateStorage } from "./indexing";
import { findGitRepoRoot, getTsconfigPathForFile } from "./project";
import { openStorage, Storage } from "./storage";
import { DebugOptions } from "./objstore";
import { normalizePaths, denormalizePath } from "./pathUtils";
import { FileSystem } from "./filesystem";

export interface TsortOptions {
  projectScope?: boolean;
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

  // Normalize all input paths to absolute paths
  const absoluteModulePaths = normalizePaths(modulePaths);
  const moduleSet = new Set(absoluteModulePaths);

  // Find git repo root and open storage
  const tsPath = absoluteModulePaths.at(0);
  if (tsPath === undefined) {
    throw new Error('No module paths provided');
  }
  const repoRoot = findGitRepoRoot(tsPath);
  const db = openStorage(debugOptions, false);
  await updateStorage(repoRoot, db, true, fileSystem);

  // Get tsconfig path for project scope filtering if needed
  const tsconfigPath = options.projectScope
    ? await getTsconfigPathForFile(repoRoot, tsPath, fileSystem)
    : null;

  // Build the dependency graph considering only the input modules
  const { graph, reverseGraph } = buildDependencyGraph(db, moduleSet, tsconfigPath);

  // Perform topological sort using Kahn's algorithm
  const sorted = topologicalSort(moduleSet, graph, reverseGraph);

  if (sorted === null) {
    // Cycle detected
    const cycleNodes = findCycleNodes(moduleSet, graph);
    const cwd = process.cwd();
    console.error('tsort: cycle detected in input modules:');
    for (const node of cycleNodes) {
      console.error(`  ${denormalizePath(node, cwd)}`);
    }
    process.exit(1);
  }

  // Output modules in sorted order (dependencies first)
  for (const modulePath of sorted) {
    console.log(modulePath);
  }

  db.save();
}

/**
 * Build a dependency graph for the given set of modules.
 *
 * @returns graph: Map of module -> modules it imports (within the set)
 * @returns reverseGraph: Map of module -> modules that import it (within the set)
 */
function buildDependencyGraph(
  db: Storage,
  moduleSet: Set<string>,
  tsconfigPath: string | null
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
    buildEdgesForModule(modulePath, db, moduleSet, tsconfigPath, graph, reverseGraph);
  }

  return { graph, reverseGraph };
}

function buildEdgesForModule(
  modulePath: string,
  db: Storage,
  moduleSet: Set<string>,
  tsconfigPath: string | null,
  graph: Map<string, Set<string>>,
  reverseGraph: Map<string, Set<string>>
): void {
  const exporters = db.getExporterPathsOfImport(modulePath);

  for (const exporter of exporters) {
    if (shouldSkipExporter(exporter, tsconfigPath)) {
      continue;
    }
    addEdgeIfInScope(modulePath, exporter.path, moduleSet, graph, reverseGraph);
  }
}

function shouldSkipExporter(
  exporter: { path: string; tsconfig: string },
  tsconfigPath: string | null
): boolean {
  return tsconfigPath !== null && tsconfigPath !== exporter.tsconfig;
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
  const deps = graph.get(modulePath);
  if (deps === undefined) {
    return;
  }
  deps.add(exporterPath);
  const reverseDeps = reverseGraph.get(exporterPath);
  if (reverseDeps === undefined) {
    return;
  }
  reverseDeps.add(modulePath);
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
    const rev = reverseGraph.get(modulePath);
    if (rev === undefined) {
      continue;
    }
    inDegree.set(modulePath, rev.size);
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
    processDependencies(current, graph, inDegree, queue);
  }

  return result;
}

function processDependencies(
  current: string,
  graph: Map<string, Set<string>>,
  inDegree: Map<string, number>,
  queue: string[]
): void {
  const deps = graph.get(current);
  if (deps === undefined) {
    return;
  }
  for (const dependency of deps) {
    const depInDegree = inDegree.get(dependency);
    if (depInDegree === undefined) {
      continue;
    }
    const newInDegree = depInDegree - 1;
    inDegree.set(dependency, newInDegree);
    if (newInDegree === 0) {
      insertSorted(queue, dependency);
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
