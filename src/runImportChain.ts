import { CliError } from './errors';
import { FileSystem } from './filesystem';
import { updateStorage } from './indexing';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath } from './pathUtils';
import { findGitRepoRoot } from './project';
import { openStorage, type Storage } from './storage';

/**
 * Result of building an import chain.
 */
export interface ImportChainResult {
  /** True when a path from `fromPath` to `toPath` was found. */
  found: boolean;
  /**
   * Chain of module paths from `fromPath` toward `toPath`.
   * When `found` is false, contains only the starting node.
   */
  chain: string[];
}

/**
 * Walk the import-chain graph from `fromPath` to `toPath` and collect
 * the shortest path.
 *
 * @param db - Storage with import/export index
 * @param fromPath - Starting file path
 * @param toPath - Target file path
 * @returns Result with the chain and whether a path was found
 */
export function buildImportChain(
  db: Storage,
  fromPath: string,
  toPath: string,
): ImportChainResult {
  const chain: string[] = [];
  const cache = new Map<string, NodeInfo>();
  let node: NodeInfo | null = getImportChainDown(db, cache, fromPath, toPath);

  // When no path exists, node.down is null and the chain contains only
  // the starting node.
  const found = node.down !== null;

  while (node) {
    chain.push(node.id);
    node = pickNextNode(node);
  }

  return { found, chain };
}

/**
 * Trace the import dependency chain from `fromPath` to `toPath`.
 *
 * Builds a BFS graph of reverse dependencies (who imports a file) and
 * prints each node on the shortest path from `fromPath` to `toPath`.
 *
 * @param fromPath - Starting file path
 * @param toPath - Target file path
 * @param debugOptions - Debug tracing configuration for the object store
 * @param fresh - When true, delete the existing index database before rebuilding
 * @param fileSystem - File system abstraction for I/O operations
 * @param writer - Callback for all output (progress and chain nodes); tests can supply a stub
 */
export async function runImportChain(
  fromPath: string,
  toPath: string,
  debugOptions: DebugOptions,
  fresh: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  const resolvedFromPath = normalizeAndValidatePath(
    fromPath,
    'From path',
    false,
  );
  const resolvedToPath = normalizeAndValidatePath(toPath, 'To path', false);

  const fromRepoRoot = findGitRepoRoot(resolvedFromPath);
  const toRepoRoot = findGitRepoRoot(resolvedToPath);
  if (fromRepoRoot !== toRepoRoot) {
    throw new CliError('From and to paths are in different repositories');
  }

  const db = openStorage(debugOptions, {
    verbose: true,
    fresh,
    basePath: fromRepoRoot,
    inMemory: false,
  });
  await updateStorage(fromRepoRoot, db, true, fileSystem, writer);
  db.save();

  const { found, chain } = buildImportChain(
    db,
    resolvedFromPath,
    resolvedToPath,
  );

  if (!found) {
    writer(
      `No import chain found from ${resolvedFromPath} to ${resolvedToPath}\n`,
    );
    return;
  }

  for (const path of chain) {
    writer(path + '\n');
  }
}

/**
 * Pick the child node with the lowest BFS score (closest to the target).
 *
 * @returns The best child node, or null if the node has no `down` direction
 *   or has no children (target reached).
 */
export function pickNextNode(node: NodeInfo): NodeInfo | null {
  if (!node.down) {
    return null;
  }
  let best: NodeInfo | null = null;
  let bestScore = Infinity;
  for (const nextNode of node.down.nodes) {
    // biome-ignore lint/style/noNonNullAssertion: BFS build populates `down` for all nodes in `down.nodes`.
    const score = nextNode.down!.score;
    if (!best || score < bestScore) {
      best = nextNode;
      bestScore = score;
    }
  }
  return best;
}

interface Direction {
  nodes: NodeInfo[];
  score: number;
}

/**
 * A node in the import-chain graph.
 *
 * `down` is populated by the BFS build phase and points toward
 * the target.
 */
export interface NodeInfo {
  id: string;
  down: Direction | null;
}

/**
 * Get or create a NodeInfo for the given path in the cache.
 *
 * @param cache - Cache of previously created nodes
 * @param id - File path used as the node identifier
 * @returns The cached or newly created NodeInfo
 */
function getNodeInfo(cache: Map<string, NodeInfo>, id: string): NodeInfo {
  let node = cache.get(id);
  if (!node) {
    node = { id, down: null };
    cache.set(id, node);
  }
  return node;
}

/**
 * Build the import-chain graph from `fromPath` toward `toPath`.
 *
 * Populates `node.down` for every visited node so that `pickNextNode`
 * can walk the chain from `fromPath` to `toPath`.  If `toPath` is not
 * reachable from `fromPath`, `node.down` remains null.
 *
 * @param db - Storage with import/export index
 * @param cache - Cache shared across calls to avoid duplicate nodes
 * @param fromPath - Starting file (walk begins here)
 * @param toPath - Target file (walk ends here)
 * @returns The NodeInfo for `fromPath`; `down` is populated only when a path exists
 */
export function getImportChainDown(
  db: Storage,
  cache: Map<string, NodeInfo>,
  fromPath: string,
  toPath: string,
): NodeInfo {
  const node = getNodeInfo(cache, fromPath);
  populateDown(db, cache, node, toPath);
  return node;
}

function populateDown(
  db: Storage,
  cache: Map<string, NodeInfo>,
  node: NodeInfo,
  toPath: string,
): void {
  if (node.id === toPath) {
    node.down = { nodes: [], score: 1 };
    return;
  }

  const bfsResult = bfsFindPath(db, node.id, toPath);
  if (!bfsResult) {
    return;
  }

  buildDownDirection(db, cache, bfsResult.levels, bfsResult.targetDist);
}

interface BfsResult {
  levels: Map<number, Set<string>>;
  targetDist: number;
}

/**
 * BFS from `fromPath` through reverse dependencies (who imports a file).
 * Returns level maps and target distance if `toPath` is reachable, or null otherwise.
 */
function bfsFindPath(
  db: Storage,
  fromPath: string,
  toPath: string,
): BfsResult | null {
  const levels = new Map<number, Set<string>>();
  const visited = new Set<string>();
  const queue: [path: string, dist: number][] = [[fromPath, 0]];

  visited.add(fromPath);
  levels.set(0, new Set([fromPath]));

  for (const [current, currentDist] of queue) {
    for (const importerPath of db.getImportersOfExportPath(current)) {
      if (visited.has(importerPath)) {
        continue;
      }
      visited.add(importerPath);
      const newDist = currentDist + 1;

      const level = levels.get(newDist);
      if (level) {
        level.add(importerPath);
      } else {
        levels.set(newDist, new Set([importerPath]));
      }

      if (importerPath === toPath) {
        return { levels, targetDist: newDist };
      }
      queue.push([importerPath, newDist]);
    }
  }

  return null;
}

/**
 * Build `down` for every visited node, iterating from the target
 * level back to the root.  Target gets score 1; others get
 * (distance from target + 1).
 */
function buildDownDirection(
  db: Storage,
  cache: Map<string, NodeInfo>,
  levels: Map<number, Set<string>>,
  targetDist: number,
): void {
  for (let d = targetDist; d >= 0; d--) {
    const level = levels.get(d);
    if (!level) {
      continue;
    }
    for (const path of level) {
      const node = getNodeInfo(cache, path);
      if (d === targetDist) {
        node.down = { nodes: [], score: 1 };
      } else {
        node.down = {
          nodes: collectDownNodes(db, cache, path, levels, d),
          score: targetDist - d + 1,
        };
      }
    }
  }
}

/**
 * Collect child nodes for `path` that live at the next BFS level.
 */
function collectDownNodes(
  db: Storage,
  cache: Map<string, NodeInfo>,
  path: string,
  levels: Map<number, Set<string>>,
  distance: number,
): NodeInfo[] {
  const nextLevel = levels.get(distance + 1);
  const downNodes: NodeInfo[] = [];
  for (const importerPath of db.getImportersOfExportPath(path)) {
    if (nextLevel?.has(importerPath)) {
      downNodes.push(getNodeInfo(cache, importerPath));
    }
  }
  return downNodes;
}
