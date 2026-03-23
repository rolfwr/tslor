import { updateStorage } from "./indexing.js";
import { findGitRepoRoot, getTsconfigPathForFile } from "./project.js";
import { openStorage, Storage } from "./storage.js";
import { DebugOptions } from "./objstore.js";
import { normalizePaths, denormalizePath } from "./pathUtils.js";
import { FileSystem } from "./filesystem.js";

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
  const repoRoot = findGitRepoRoot(absoluteModulePaths[0]);
  const db = openStorage(debugOptions, false);
  await updateStorage(repoRoot, db, true, fileSystem);

  // Get tsconfig path for project scope filtering if needed
  const tsconfigPath = options.projectScope
    ? await getTsconfigPathForFile(repoRoot, absoluteModulePaths[0], fileSystem)
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
    const exporters = db.getExporterPathsOfImport(modulePath);

    for (const exporter of exporters) {
      // Apply project scope filter if specified
      if (tsconfigPath && tsconfigPath !== exporter.tsconfig) {
        continue;
      }

      // Only include edges where both endpoints are in the input set
      if (moduleSet.has(exporter.path)) {
        // modulePath imports exporter.path
        graph.get(modulePath)!.add(exporter.path);
        // exporter.path is imported by modulePath
        reverseGraph.get(exporter.path)!.add(modulePath);
      }
    }
  }

  return { graph, reverseGraph };
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
  // Calculate in-degree (number of modules that import each module)
  const inDegree = new Map<string, number>();
  for (const modulePath of moduleSet) {
    inDegree.set(modulePath, reverseGraph.get(modulePath)!.size);
  }

  // Initialize queue with nodes that have no dependents (in-degree 0)
  // Sort alphabetically for deterministic output
  const queue: string[] = [];
  for (const modulePath of moduleSet) {
    if (inDegree.get(modulePath) === 0) {
      queue.push(modulePath);
    }
  }
  queue.sort();

  const result: string[] = [];

  while (queue.length > 0) {
    // Take first element (alphabetically first) for deterministic order
    const current = queue.shift()!;
    result.push(current);

    // For each module that current imports
    for (const dependency of graph.get(current)!) {
      // Decrement its in-degree (we've processed one of its dependents)
      const newInDegree = inDegree.get(dependency)! - 1;
      inDegree.set(dependency, newInDegree);

      // If it has no more dependents, add to queue
      if (newInDegree === 0) {
        // Insert in sorted position for deterministic order
        const insertIndex = queue.findIndex(q => q > dependency);
        if (insertIndex === -1) {
          queue.push(dependency);
        } else {
          queue.splice(insertIndex, 0, dependency);
        }
      }
    }
  }

  // If we didn't process all nodes, there's a cycle
  if (result.length < moduleSet.size) {
    return null;
  }

  return result;
}

/**
 * Find nodes that are part of cycles for error reporting.
 */
function findCycleNodes(
  moduleSet: Set<string>,
  graph: Map<string, Set<string>>
): Set<string> {
  // Find nodes involved in cycles using DFS
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycleNodes = new Set<string>();

  function dfs(node: string, path: string[]): boolean {
    visited.add(node);
    recStack.add(node);

    for (const neighbor of graph.get(node) || []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor, [...path, neighbor])) {
          // Mark all nodes in the cycle
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart !== -1) {
            for (let i = cycleStart; i < path.length; i++) {
              cycleNodes.add(path[i]);
            }
          }
          cycleNodes.add(node);
          return true;
        }
      } else if (recStack.has(neighbor)) {
        // Found a cycle
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart !== -1) {
          for (let i = cycleStart; i < path.length; i++) {
            cycleNodes.add(path[i]);
          }
        }
        cycleNodes.add(neighbor);
        cycleNodes.add(node);
        return true;
      }
    }

    recStack.delete(node);
    return false;
  }

  for (const node of moduleSet) {
    if (!visited.has(node)) {
      dfs(node, [node]);
    }
  }

  return cycleNodes;
}
