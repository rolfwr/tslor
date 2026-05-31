/*
  Pure graph algorithms for coupling analysis.

  All functions operate on directed graphs represented as adjacency maps
  where `ReadonlyMap<string, ReadonlySet<string>>` maps each node to the
  set of nodes it depends on (outgoing edges from that node).
*/

/**
 * A strongly-connected component, represented as a sorted non-empty list of member names.
 */
export type SCC = readonly [string, ...string[]];

/**
 * Adjacency map: each node maps to the set of nodes it depends on.
 */
export type AdjacencyMap = ReadonlyMap<string, ReadonlySet<string>>;

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
 * @returns Array of SCCs, each a sorted array of node names. SCCs are
 *          emitted in reverse topological order of the condensation graph
 *          (sinks first), which is Tarjan's natural output.
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
      const neighborLowlink = requiredMapGet(
        lowlinks,
        neighbor,
        `lowlink for neighbor node ${neighbor}`
      );
      lowerLowlink(node, neighborLowlink);
      return;
    }

    if (!onStack.has(neighbor)) {
      return;
    }

    const neighborIndex = requiredMapGet(indices, neighbor, `index for neighbor node ${neighbor}`);
    lowerLowlink(node, neighborIndex);
  }

  function collectRootComponent(root: string): void {
    const rootLowlink = requiredMapGet(lowlinks, root, `lowlink for root node ${root}`);
    const rootIndex = requiredMapGet(indices, root, `index for root node ${root}`);
    if (rootLowlink !== rootIndex) {
      return;
    }

    const firstMember = stack.pop();
    if (firstMember === undefined) {
      throw new Error('Tarjan stack underflow while collecting SCC members');
    }

    onStack.delete(firstMember);

    const component: [string, ...string[]] = [firstMember];
    let currentMember = firstMember;

    while (currentMember !== root) {
      const popped = stack.pop();
      if (popped === undefined) {
        throw new Error('Tarjan stack underflow while collecting SCC members');
      }

      onStack.delete(popped);
      component.push(popped);
      currentMember = popped;
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
 * @throws {Error} If `sccs` is not a valid partition of graph nodes
 *                 (missing coverage, duplicate membership, or membership
 *                 of nodes that do not exist in the graph).
 */
function mapNodesToSccIndices(sccs: ReadonlyArray<SCC>): Map<string, number> {
  const nodeToScc = new Map<string, number>();
  for (const [sccIndex, scc] of sccs.entries()) {
    for (const member of scc) {
      if (!nodeToScc.has(member)) {
        nodeToScc.set(member, sccIndex);
        continue;
      }

      const previousSccIndex = requiredMapGet(
        nodeToScc,
        member,
        `previous SCC index for duplicate node ${member}`
      );
      throw new Error(
        `Node ${member} appears in multiple SCCs: ${String(previousSccIndex)} and ${String(sccIndex)}`
      );
    }
  }

  return nodeToScc;
}

function createDagNodes(sccCount: number): Map<number, Set<number>> {
  const dag = new Map<number, Set<number>>();
  for (let i = 0; i < sccCount; i++) {
    dag.set(i, new Set());
  }
  return dag;
}

function populateDagEdges(
  graph: AdjacencyMap,
  nodeToScc: ReadonlyMap<string, number>,
  dag: ReadonlyMap<number, Set<number>>
): Set<string> {
  const graphNodes = new Set<string>();
  for (const [node, deps] of graph) {
    graphNodes.add(node);
    const fromScc = requiredMapGet(nodeToScc, node, `SCC index for node ${node}`);
    const sccDeps = requiredMapGet(dag, fromScc, `DAG node for SCC ${String(fromScc)}`);

    for (const dep of deps) {
      graphNodes.add(dep);
      const toScc = requiredMapGet(
        nodeToScc,
        dep,
        `SCC index for dependency node ${dep} referenced from ${node}`
      );
      if (toScc !== fromScc) {
        sccDeps.add(toScc);
      }
    }
  }

  return graphNodes;
}

function assertAllSccNodesExistInGraph(
  nodeToScc: ReadonlyMap<string, number>,
  graphNodes: ReadonlySet<string>
): void {
  for (const member of nodeToScc.keys()) {
    if (graphNodes.has(member)) {
      continue;
    }

    throw new Error(`Node ${member} appears in SCCs but is not present in the graph`);
  }
}

export function condenseToDAG(
  graph: AdjacencyMap,
  sccs: ReadonlyArray<SCC>
): Map<number, Set<number>> {
  const nodeToScc = mapNodesToSccIndices(sccs);
  const dag = createDagNodes(sccs.length);
  const graphNodes = populateDagEdges(graph, nodeToScc, dag);
  assertAllSccNodesExistInGraph(nodeToScc, graphNodes);
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
 * @throws {Error} If `dag` contains a cycle.
 */
export function computeTopologicalDepth(
  dag: ReadonlyMap<number, ReadonlySet<number>>
): Map<number, number> {
  const depth = new Map<number, number>();
  const visiting = new Set<number>();

  // Initialize all nodes with depth -1 (unvisited)
  for (const node of dag.keys()) {
    depth.set(node, -1);
  }

  function dfs(node: number): number {
    const knownDepth = requiredMapGet(depth, node, `depth entry for SCC ${String(node)}`);
    if (knownDepth !== -1) {
      return knownDepth;
    }

    if (visiting.has(node)) {
      throw new Error(`Cycle detected in DAG while computing depth for SCC ${String(node)}`);
    }

    visiting.add(node);
    try {
      const deps = requiredMapGet(dag, node, `DAG dependencies for SCC ${String(node)}`);
      if (deps.size === 0) {
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
    } finally {
      visiting.delete(node);
    }
  }

  for (const node of dag.keys()) {
    dfs(node);
  }

  return depth;
}
