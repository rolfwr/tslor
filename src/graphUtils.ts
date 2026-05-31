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
 * Depth is the shortest path from the SCC to any leaf SCC (no outgoing
 * edges). Leaf SCCs have depth 0.
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

      let minDepDepth = Number.POSITIVE_INFINITY;
      for (const dep of deps) {
        const depDepth = dfs(dep) + 1;
        if (depDepth < minDepDepth) {
          minDepDepth = depDepth;
        }
      }

      depth.set(node, minDepDepth);
      return minDepDepth;
    } finally {
      visiting.delete(node);
    }
  }

  for (const node of dag.keys()) {
    dfs(node);
  }

  return depth;
}

function leafSccIndices(
  dag: ReadonlyMap<number, ReadonlySet<number>>
): number[] {
  const leaves: number[] = [];

  for (const [sccIndex, dependencies] of dag) {
    if (dependencies.size === 0) {
      leaves.push(sccIndex);
    }
  }

  leaves.sort((left, right) => left - right);
  return leaves;
}

function buildUndirectedAdjacency(
  dag: ReadonlyMap<number, ReadonlySet<number>>
): Map<number, Set<number>> {
  const undirected = new Map<number, Set<number>>();

  for (const sccIndex of dag.keys()) {
    undirected.set(sccIndex, new Set<number>());
  }

  for (const [fromSccIndex, dependencies] of dag) {
    const fromNeighbors = requiredMapGet(
      undirected,
      fromSccIndex,
      `undirected adjacency node for SCC ${String(fromSccIndex)}`
    );

    for (const toSccIndex of dependencies) {
      const toNeighbors = requiredMapGet(
        undirected,
        toSccIndex,
        `undirected adjacency node for SCC ${String(toSccIndex)}`
      );

      fromNeighbors.add(toSccIndex);
      toNeighbors.add(fromSccIndex);
    }
  }

  return undirected;
}

function shortestPathDistances(
  undirected: ReadonlyMap<number, ReadonlySet<number>>,
  startSccIndex: number
): Map<number, number> {
  const distances = new Map<number, number>();
  const queue: number[] = [startSccIndex];
  distances.set(startSccIndex, 0);

  let cursor = 0;
  while (cursor < queue.length) {
    const currentSccIndex = queue[cursor];
    if (currentSccIndex === undefined) {
      throw new Error('Queue index went out of range while traversing SCC distances');
    }

    cursor++;

    const currentDistance = requiredMapGet(
      distances,
      currentSccIndex,
      `distance for SCC ${String(currentSccIndex)}`
    );
    const neighbors = requiredMapGet(
      undirected,
      currentSccIndex,
      `undirected neighbors for SCC ${String(currentSccIndex)}`
    );

    for (const neighborSccIndex of neighbors) {
      if (distances.has(neighborSccIndex)) {
        continue;
      }

      distances.set(neighborSccIndex, currentDistance + 1);
      queue.push(neighborSccIndex);
    }
  }

  return distances;
}

/**
 * Compute pairwise leaf distances over the SCC DAG.
 *
 * Distance is the minimum number of edges between two leaf SCCs when the DAG
 * is traversed as an undirected graph. Leaves in different disconnected
 * components are marked as `null` (unreachable).
 *
 * @param dag - Condensed DAG from `condenseToDAG()`
 * @returns Map keyed by leaf SCC index with nested maps to every other leaf
 */
export function computeLeafDistanceMatrix(
  dag: ReadonlyMap<number, ReadonlySet<number>>
): Map<number, Map<number, number | null>> {
  const leaves = leafSccIndices(dag);
  const undirected = buildUndirectedAdjacency(dag);
  const matrix = new Map<number, Map<number, number | null>>();

  for (const leafSccIndex of leaves) {
    const allDistancesFromLeaf = shortestPathDistances(undirected, leafSccIndex);
    const row = new Map<number, number | null>();

    for (const targetLeafSccIndex of leaves) {
      const distance = allDistancesFromLeaf.get(targetLeafSccIndex);
      row.set(targetLeafSccIndex, distance === undefined ? null : distance);
    }

    matrix.set(leafSccIndex, row);
  }

  return matrix;
}

/**
 * Result of partitioning leaf SCCs into two distance-separated clusters.
 */
export interface LeafSccPartition {
  clusterA: number[];
  clusterB: number[];
  crossClusterDistanceSum: number;
}

function distanceWeight(distance: number | null): number {
  return distance ?? 0;
}

function clusterMembershipMaskFromAssignment(assignment: readonly boolean[]): string {
  return assignment.map((isInA) => (isInA ? '1' : '0')).join('');
}

function clusterScore(
  leaves: readonly number[],
  matrix: ReadonlyMap<number, ReadonlyMap<number, number | null>>,
  assignment: readonly boolean[]
): number {
  let score = 0;

  for (let leftIndex = 0; leftIndex < leaves.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < leaves.length; rightIndex++) {
      if (assignment[leftIndex] === assignment[rightIndex]) {
        continue;
      }

      const leftLeaf = leaves[leftIndex];
      const rightLeaf = leaves[rightIndex];
      if (leftLeaf === undefined || rightLeaf === undefined) {
        throw new Error('Expected leaf SCC indices while scoring a partition');
      }

      const leftRow = requiredMapGet(matrix, leftLeaf, `distance row for leaf SCC ${String(leftLeaf)}`);
      const distance = requiredMapGet(
        leftRow,
        rightLeaf,
        `distance between leaf SCC ${String(leftLeaf)} and ${String(rightLeaf)}`
      );

      score += distanceWeight(distance);
    }
  }

  return score;
}

function hasBothClusters(assignment: readonly boolean[]): boolean {
  const clusterASize = assignment.filter((isInA) => isInA).length;
  return clusterASize > 0 && clusterASize < assignment.length;
}

function buildAssignmentFromMask(leafCount: number, mask: number): boolean[] {
  const assignment = Array.from<boolean>({ length: leafCount }).fill(false);
  assignment[0] = true;

  for (let bitIndex = 0; bitIndex < leafCount - 1; bitIndex++) {
    assignment[bitIndex + 1] = (mask & (1 << bitIndex)) !== 0;
  }

  return assignment;
}

function selectBetterAssignment(
  candidate: readonly boolean[],
  candidateScore: number,
  best: readonly boolean[] | null,
  bestScore: number
): readonly boolean[] | null {
  if (candidateScore > bestScore || best === null) {
    return [...candidate];
  }

  if (candidateScore < bestScore) {
    return best;
  }

  const candidateMask = clusterMembershipMaskFromAssignment(candidate);
  const bestMask = clusterMembershipMaskFromAssignment(best);
  return candidateMask < bestMask ? [...candidate] : best;
}

function exactLeafPartitionAssignment(
  leaves: readonly number[],
  matrix: ReadonlyMap<number, ReadonlyMap<number, number | null>>
): { assignment: boolean[]; score: number } {
  const totalMasks = 1 << (leaves.length - 1);
  let bestAssignment: readonly boolean[] | null = null;
  let bestScore = -1;

  for (let mask = 0; mask < totalMasks; mask++) {
    const assignment = buildAssignmentFromMask(leaves.length, mask);
    if (!hasBothClusters(assignment)) {
      continue;
    }

    const score = clusterScore(leaves, matrix, assignment);
    const selected = selectBetterAssignment(assignment, score, bestAssignment, bestScore);
    if (selected !== bestAssignment) {
      bestAssignment = selected;
      bestScore = score;
    }
  }

  if (bestAssignment === null) {
    throw new Error('Unable to derive a non-trivial leaf SCC partition');
  }

  return {
    assignment: [...bestAssignment],
    score: bestScore,
  };
}

function findFarthestLeafIndex(
  leaves: readonly number[],
  matrix: ReadonlyMap<number, ReadonlyMap<number, number | null>>
): number {
  const firstLeaf = leaves[0];
  if (firstLeaf === undefined) {
    throw new Error('Expected at least one leaf SCC while seeding heuristic partition');
  }

  const firstLeafRow = requiredMapGet(matrix, firstLeaf, `distance row for leaf SCC ${String(firstLeaf)}`);
  let farthestLeafIndex = 1;
  let farthestLeafDistance = -1;

  for (let i = 1; i < leaves.length; i++) {
    const candidateLeaf = leaves[i];
    if (candidateLeaf === undefined) {
      throw new Error('Expected candidate leaf SCC while selecting heuristic seed');
    }

    const candidateDistance = distanceWeight(
      requiredMapGet(
        firstLeafRow,
        candidateLeaf,
        `distance between leaf SCC ${String(firstLeaf)} and ${String(candidateLeaf)}`
      )
    );

    if (candidateDistance > farthestLeafDistance) {
      farthestLeafDistance = candidateDistance;
      farthestLeafIndex = i;
    }
  }

  return farthestLeafIndex;
}

function greedyLeafPartitionAssignment(
  leaves: readonly number[],
  matrix: ReadonlyMap<number, ReadonlyMap<number, number | null>>
): { assignment: boolean[]; score: number } {
  const assignment = Array.from<boolean>({ length: leaves.length }).fill(false);
  assignment[0] = true;

  const farthestLeafIndex = findFarthestLeafIndex(leaves, matrix);
  assignment[farthestLeafIndex] = false;

  for (let i = 1; i < leaves.length; i++) {
    if (i === farthestLeafIndex) {
      continue;
    }

    assignment[i] = true;
    const scoreIfA = clusterScore(leaves, matrix, assignment);
    assignment[i] = false;
    const scoreIfB = clusterScore(leaves, matrix, assignment);
    assignment[i] = scoreIfA >= scoreIfB;
  }

  return {
    assignment,
    score: clusterScore(leaves, matrix, assignment),
  };
}

function clustersFromAssignment(
  leaves: readonly number[],
  assignment: readonly boolean[]
): { clusterA: number[]; clusterB: number[] } {
  const clusterA: number[] = [];
  const clusterB: number[] = [];

  for (const [index, leafSccIndex] of leaves.entries()) {
    if (assignment[index] === true) {
      clusterA.push(leafSccIndex);
      continue;
    }

    clusterB.push(leafSccIndex);
  }

  return { clusterA, clusterB };
}

/**
 * Partition leaf SCCs into two clusters that maximize cross-cluster separation.
 *
 * The optimization objective is the sum of pairwise leaf distances across the
 * two clusters, using `computeLeafDistanceMatrix()` distances.
 *
 * @param dag - Condensed DAG from `condenseToDAG()`
 * @returns Deterministic 2-way partition and objective score
 */
export function partitionLeafSccsByDistance(
  dag: ReadonlyMap<number, ReadonlySet<number>>
): LeafSccPartition {
  const leaves = leafSccIndices(dag);
  if (leaves.length < 2) {
    return {
      clusterA: [...leaves],
      clusterB: [],
      crossClusterDistanceSum: 0,
    };
  }

  const matrix = computeLeafDistanceMatrix(dag);
  const maxExactLeaves = 20;
  const result =
    leaves.length <= maxExactLeaves
      ? exactLeafPartitionAssignment(leaves, matrix)
      : greedyLeafPartitionAssignment(leaves, matrix);

  const clusters = clustersFromAssignment(leaves, result.assignment);

  return {
    clusterA: clusters.clusterA,
    clusterB: clusters.clusterB,
    crossClusterDistanceSum: result.score,
  };
}
