/**
 * Pure graph algorithms for coupling analysis.
 *
 * All functions operate on directed graphs represented as adjacency maps
 * where `Map<string, Set<string>>` maps each node to the set of nodes
 * it depends on (outgoing edges from that node).
 */

/**
 * A strongly-connected component, represented as a sorted list of member names.
 */
export type SCC = ReadonlyArray<string>;

/**
 * Adjacency map: each node maps to the set of nodes it depends on.
 */
export type AdjacencyMap = Map<string, Set<string>>;

function requiredMapGet<K, V>(
  map: ReadonlyMap<K, V>,
  key: K,
  context: string
): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Expected ${context} to exist`);
  }
  return value;
}

/**
 * Find strongly-connected components using Tarjan's algorithm.
 *
 * Two nodes share an SCC only when each is reachable from the other
 * through directed edges. Singleton nodes with no mutual edges are
 * separate SCCs.
 *
 * @returns Array of SCCs, each a sorted array of node names. Order of
 *          SCCs in the outer array is reverse-topological (sinks last),
 *          which is the natural output of Tarjan's algorithm.
 */
export function findSCCs(graph: AdjacencyMap): SCC[] {
  const nodes = [...graph.keys()];
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const result: SCC[] = [];

  function markNodeAsActive(node: string): void {
    indices.set(node, index);
    lowlinks.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);
  }

  function lowerLowlink(node: string, candidate: number): void {
    const currentLowlink = requiredMapGet(lowlinks, node, `lowlink for node ${node}`);
    if (candidate < currentLowlink) {
      lowlinks.set(node, candidate);
    }
  }

  function handleNeighbor(node: string, neighbor: string): void {
    if (!indices.has(neighbor)) {
      strongconnect(neighbor);
      const neighborLowlink = lowlinks.get(neighbor);
      if (neighborLowlink !== undefined) {
        lowerLowlink(node, neighborLowlink);
      }
      return;
    }

    if (!onStack.has(neighbor)) {
      return;
    }

    const neighborIndex = indices.get(neighbor);
    if (neighborIndex !== undefined) {
      lowerLowlink(node, neighborIndex);
    }
  }

  function collectRootComponent(root: string): void {
    const rootLowlink = lowlinks.get(root);
    const rootIndex = indices.get(root);
    if (rootLowlink === undefined || rootIndex === undefined || rootLowlink !== rootIndex) {
      return;
    }

    const component: string[] = [];
    while (true) {
      const popped = stack.pop();
      if (popped === undefined) {
        throw new Error('Tarjan stack underflow while collecting SCC members');
      }
      onStack.delete(popped);
      component.push(popped);
      if (popped === root) {
        break;
      }
    }

    component.sort();
    result.push(component);
  }

  function strongconnect(node: string): void {
    markNodeAsActive(node);

    const neighbors = graph.get(node);
    if (neighbors !== undefined) {
      for (const neighbor of neighbors) {
        handleNeighbor(node, neighbor);
      }
    }

    collectRootComponent(node);
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongconnect(node);
    }
  }

  return result;
}

/**
 * Condense SCCs into a DAG.
 *
 * Each SCC becomes a single node. Edges between SCCs are derived from
 * the original graph: if any member of SCC A depends on any member of
 * SCC B, then the condensed DAG has an edge from A to B.
 *
 * @param graph - Original adjacency map
 * @param sccs - Strongly-connected components from `findSCCs()`
 * @returns Adjacency map where keys are SCC indices and values are
 *          sets of SCC indices that the key SCC depends on.
 */
export function condenseToDAG(
  graph: AdjacencyMap,
  sccs: SCC[]
): Map<number, Set<number>> {
  // Map each node to its SCC index
  const nodeToScc = new Map<string, number>();
  for (const [sccIndex, scc] of sccs.entries()) {
    for (const member of scc) {
      nodeToScc.set(member, sccIndex);
    }
  }

  const dag = new Map<number, Set<number>>();
  for (let i = 0; i < sccs.length; i++) {
    dag.set(i, new Set());
  }

  for (const [node, deps] of graph) {
    const fromScc = nodeToScc.get(node);
    if (fromScc === undefined) {
      continue;
    }
    for (const dep of deps) {
      const toScc = nodeToScc.get(dep);
      if (toScc !== undefined && toScc !== fromScc) {
        const sccDeps = requiredMapGet(dag, fromScc, `DAG node for SCC ${String(fromScc)}`);
        sccDeps.add(toScc);
      }
    }
  }

  return dag;
}

/**
 * Compute topological depth for each SCC in the condensed DAG.
 *
 * Depth is the longest path from any leaf SCC (no outgoing edges)
 * to the given SCC. Leaf SCCs have depth 0.
 *
 * @param dag - Condensed DAG from `condenseToDAG()`
 * @returns Map from SCC index to its depth (non-negative integer)
 */
export function computeTopologicalDepth(
  dag: Map<number, Set<number>>
): Map<number, number> {
  const depth = new Map<number, number>();

  // Initialize all nodes with depth -1 (unvisited)
  for (const node of dag.keys()) {
    depth.set(node, -1);
  }

  function dfs(node: number): number {
    const knownDepth = requiredMapGet(depth, node, `depth entry for SCC ${String(node)}`);
    if (knownDepth !== -1) {
      return knownDepth;
    }

    const deps = dag.get(node);
    if (deps === undefined || deps.size === 0) {
      depth.set(node, 0);
      return 0;
    }

    let maxDepDepth = 0;
    for (const dep of deps) {
      const depDepth = dfs(dep);
      if (depDepth + 1 > maxDepDepth) {
        maxDepDepth = depDepth + 1;
      }
    }

    depth.set(node, maxDepDepth);
    return maxDepDepth;
  }

  for (const node of dag.keys()) {
    dfs(node);
  }

  return depth;
}
