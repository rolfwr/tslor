import { assert, describe, test } from 'vitest';
import {
  findSCCs,
  condenseToDAG,
  computeTopologicalDepth,
  computeLeafDistanceMatrix,
  partitionLeafSccsByDistance,
} from './graphUtils';
import type { SCC } from './graphUtils';

// Helper to build an adjacency map from edge tuples
function buildGraph(edges: [string, string][]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (!graph.has(from)) {
      graph.set(from, new Set());
    }
    if (!graph.has(to)) {
      graph.set(to, new Set());
    }

    const outgoingEdges = graph.get(from);
    if (outgoingEdges === undefined) {
      throw new Error(`Expected node ${from} to exist in graph`);
    }
    outgoingEdges.add(to);
  }
  return graph;
}

// Helper to ensure all listed nodes exist as keys (even with no outgoing edges)
function ensureNodes(
  graph: Map<string, Set<string>>,
  nodes: string[]
): void {
  for (const n of nodes) {
    if (!graph.has(n)) {
      graph.set(n, new Set());
    }
  }
}

/*
  Normalize SCC output for comparison: sort members within each SCC,
  then sort SCCs by their first member for deterministic ordering.
*/
function normalizeSCCMembers(scc: SCC): SCC {
  const sortedMembers = [...scc].sort();
  const firstMember = sortedMembers[0];
  if (firstMember === undefined) {
    throw new Error('Expected SCC to contain at least one member');
  }
  return [firstMember, ...sortedMembers.slice(1)];
}

function normalizeSCCs(sccs: ReadonlyArray<SCC>): string[][] {
  const normalizedSccs = sccs.map(normalizeSCCMembers);
  normalizedSccs.sort((a, b) => a[0].localeCompare(b[0]));
  return normalizedSccs.map(scc => [...scc]);
}

function mapNodesToSccIndices(
  sccs: ReadonlyArray<SCC>
): Map<string, number> {
  const nodeToIdx = new Map<string, number>();
  for (const [sccIndex, scc] of sccs.entries()) {
    for (const member of scc) {
      nodeToIdx.set(member, sccIndex);
    }
  }
  return nodeToIdx;
}

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

function nodeIndex(nodeToIdx: ReadonlyMap<string, number>, node: string): number {
  return requiredMapGet(nodeToIdx, node, `SCC index for node ${node}`);
}

function dagDeps(
  dag: ReadonlyMap<number, Set<number>>,
  sccIndex: number
): Set<number> {
  return requiredMapGet(dag, sccIndex, `DAG dependencies for SCC ${String(sccIndex)}`);
}

function nodeDepth(
  depth: ReadonlyMap<number, number>,
  nodeToIdx: ReadonlyMap<string, number>,
  node: string
): number {
  const sccIndex = nodeIndex(nodeToIdx, node);
  return requiredMapGet(depth, sccIndex, `topological depth for node ${node}`);
}

describe('findSCCs', () => {
  test('empty graph returns no SCCs', () => {
    const graph = new Map<string, Set<string>>();
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 0);
  });

  test('single node is a singleton SCC', () => {
    const graph = buildGraph([]);
    ensureNodes(graph, ['A']);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 1);
    assert.deepEqual(sccs[0], ['A']);
  });

  test('linear chain A→B→C: each node is its own SCC', () => {
    const graph = buildGraph([['A', 'B'], ['B', 'C']]);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 3);
    const normalized = normalizeSCCs(sccs);
    assert.deepEqual(normalized, [['A'], ['B'], ['C']]);
  });

  test('mutual cycle A↔B: A and B share one SCC', () => {
    const graph = buildGraph([['A', 'B'], ['B', 'A']]);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 1);
    assert.deepEqual(sccs[0], ['A', 'B']);
  });

  test('three-node cycle A→B→C→A: all share one SCC', () => {
    const graph = buildGraph([['A', 'B'], ['B', 'C'], ['C', 'A']]);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 1);
    assert.deepEqual(sccs[0], ['A', 'B', 'C']);
  });

  test('diamond pattern A→B, A→C, B→D, C→D: four singleton SCCs', () => {
    const graph = buildGraph([['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']]);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 4);
    const normalized = normalizeSCCs(sccs);
    assert.deepEqual(normalized, [['A'], ['B'], ['C'], ['D']]);
  });

  test('disconnected components: A→B and C→D form separate SCCs', () => {
    const graph = buildGraph([['A', 'B'], ['C', 'D']]);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 4);
    const normalized = normalizeSCCs(sccs);
    assert.deepEqual(normalized, [['A'], ['B'], ['C'], ['D']]);
  });

  test('disconnected components with cycle: (A↔B) and (C↔D)', () => {
    const graph = buildGraph([
      ['A', 'B'], ['B', 'A'],
      ['C', 'D'], ['D', 'C'],
    ]);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 2);
    const normalized = normalizeSCCs(sccs);
    assert.deepEqual(normalized, [['A', 'B'], ['C', 'D']]);
  });

  test('mixed: cycle (A↔B) feeds into linear chain C→D', () => {
    const graph = buildGraph([
      ['A', 'B'], ['B', 'A'], // A↔B cycle
      ['A', 'C'],             // cycle feeds into C
      ['C', 'D'],             // C→D
    ]);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 3);
    const normalized = normalizeSCCs(sccs);
    assert.deepEqual(normalized, [['A', 'B'], ['C'], ['D']]);
  });

  test('isolated node alongside connected graph', () => {
    const graph = buildGraph([['A', 'B']]);
    ensureNodes(graph, ['C']);
    const sccs = findSCCs(graph);
    assert.lengthOf(sccs, 3);
    const normalized = normalizeSCCs(sccs);
    assert.deepEqual(normalized, [['A'], ['B'], ['C']]);
  });
});

describe('condenseToDAG', () => {
  test('linear chain A→B→C: DAG mirrors original', () => {
    const graph = buildGraph([['A', 'B'], ['B', 'C']]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);

    // Find SCC indices
    const nodeToIdx = mapNodesToSccIndices(sccs);

    // A depends on B, B depends on C
    const aIdx = nodeIndex(nodeToIdx, 'A');
    const bIdx = nodeIndex(nodeToIdx, 'B');
    const cIdx = nodeIndex(nodeToIdx, 'C');

    assert.include(dagDeps(dag, aIdx), bIdx);
    assert.include(dagDeps(dag, bIdx), cIdx);
    assert.notInclude(dagDeps(dag, bIdx), aIdx); // no back-edge
  });

  test('mutual cycle A↔B: condensed to single node with no self-edge', () => {
    const graph = buildGraph([['A', 'B'], ['B', 'A']]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);

    assert.equal(dag.size, 1);
    assert.equal(dag.get(0)?.size, 0);
  });

  test('diamond: DAG preserves A→B, A→C, B→D, C→D edges', () => {
    const graph = buildGraph([['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);

    const nodeToIdx = mapNodesToSccIndices(sccs);

    const aIdx = nodeIndex(nodeToIdx, 'A');
    const bIdx = nodeIndex(nodeToIdx, 'B');
    const cIdx = nodeIndex(nodeToIdx, 'C');
    const dIdx = nodeIndex(nodeToIdx, 'D');

    assert.include(dagDeps(dag, aIdx), bIdx);
    assert.include(dagDeps(dag, aIdx), cIdx);
    assert.include(dagDeps(dag, bIdx), dIdx);
    assert.include(dagDeps(dag, cIdx), dIdx);
  });

  test('mixed: cycle (A↔B) feeds C→D: DAG has edge from AB-SCC to C-SCC', () => {
    const graph = buildGraph([
      ['A', 'B'], ['B', 'A'],
      ['A', 'C'],
      ['C', 'D'],
    ]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);

    const nodeToIdx = mapNodesToSccIndices(sccs);

    const abIdx = nodeIndex(nodeToIdx, 'A');
    const cIdx = nodeIndex(nodeToIdx, 'C');
    const dIdx = nodeIndex(nodeToIdx, 'D');

    // AB SCC depends on C
    assert.include(dagDeps(dag, abIdx), cIdx);
    // C depends on D
    assert.include(dagDeps(dag, cIdx), dIdx);
    // D has no outgoing edges
    assert.equal(dag.get(dIdx)?.size, 0);
  });

  test('throws when SCC list does not cover every node in graph dependencies', () => {
    const graph = buildGraph([['A', 'B']]);
    const invalidSccs: SCC[] = [['A']];

    assert.throws(
      () => condenseToDAG(graph, invalidSccs),
      /SCC index for dependency node B referenced from A/
    );
  });

  test('throws when SCC list includes a node that is not present in the graph', () => {
    const graph = buildGraph([['A', 'B']]);
    const invalidSccs: SCC[] = [['A'], ['B'], ['C']];

    assert.throws(
      () => condenseToDAG(graph, invalidSccs),
      /Node C appears in SCCs but is not present in the graph/
    );
  });

  test('throws when SCC list assigns a node to multiple SCCs', () => {
    const graph = buildGraph([['A', 'B']]);
    const invalidSccs: SCC[] = [['A'], ['A', 'B']];

    assert.throws(
      () => condenseToDAG(graph, invalidSccs),
      /Node A appears in multiple SCCs: 0 and 1/
    );
  });
});

describe('computeTopologicalDepth', () => {
  test('empty DAG returns empty depth map', () => {
    const dag = new Map<number, Set<number>>();
    const depth = computeTopologicalDepth(dag);
    assert.equal(depth.size, 0);
  });

  test('single node with no edges has depth 0', () => {
    const dag = new Map<number, Set<number>>();
    dag.set(0, new Set());
    const depth = computeTopologicalDepth(dag);
    assert.equal(depth.get(0), 0);
  });

  test('throws when DAG contains a cycle', () => {
    const dag = new Map<number, Set<number>>();
    dag.set(0, new Set([1]));
    dag.set(1, new Set([0]));

    assert.throws(
      () => computeTopologicalDepth(dag),
      /Cycle detected in DAG while computing depth for SCC/
    );
  });

  test('linear chain A→B→C: A has depth 2, B has depth 1, C (leaf) has depth 0', () => {
    const graph = buildGraph([['A', 'B'], ['B', 'C']]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);
    const depth = computeTopologicalDepth(dag);

    const nodeToIdx = mapNodesToSccIndices(sccs);

    assert.equal(nodeDepth(depth, nodeToIdx, 'A'), 2);
    assert.equal(nodeDepth(depth, nodeToIdx, 'B'), 1);
    assert.equal(nodeDepth(depth, nodeToIdx, 'C'), 0);
  });

  test('diamond A→B, A→C, B→D, C→D: A has depth 2, D (leaf) has depth 0', () => {
    const graph = buildGraph([['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);
    const depth = computeTopologicalDepth(dag);

    const nodeToIdx = mapNodesToSccIndices(sccs);

    assert.equal(nodeDepth(depth, nodeToIdx, 'A'), 2);
    assert.equal(nodeDepth(depth, nodeToIdx, 'B'), 1);
    assert.equal(nodeDepth(depth, nodeToIdx, 'C'), 1);
    assert.equal(nodeDepth(depth, nodeToIdx, 'D'), 0);
  });

  test('branch with uneven paths uses shallowest path to a leaf', () => {
    const graph = buildGraph([
      ['A', 'B'],
      ['A', 'C'],
      ['C', 'D'],
    ]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);
    const depth = computeTopologicalDepth(dag);

    const nodeToIdx = mapNodesToSccIndices(sccs);

    // Shortest path to a leaf from A is A→B (length 1), not A→C→D (length 2)
    assert.equal(nodeDepth(depth, nodeToIdx, 'A'), 1);
    assert.equal(nodeDepth(depth, nodeToIdx, 'B'), 0);
    assert.equal(nodeDepth(depth, nodeToIdx, 'C'), 1);
    assert.equal(nodeDepth(depth, nodeToIdx, 'D'), 0);
  });

  test('mutual cycle A↔B: condensed SCC has depth 0 (leaf in DAG)', () => {
    const graph = buildGraph([['A', 'B'], ['B', 'A']]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);
    const depth = computeTopologicalDepth(dag);

    // The single SCC has no outgoing edges in the DAG
    assert.equal(depth.get(0), 0);
  });

  test('mixed: cycle (A↔B) feeds C→D: AB has depth 2, C has depth 1, D has depth 0', () => {
    const graph = buildGraph([
      ['A', 'B'], ['B', 'A'],
      ['A', 'C'],
      ['C', 'D'],
    ]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);
    const depth = computeTopologicalDepth(dag);

    const nodeToIdx = mapNodesToSccIndices(sccs);

    assert.equal(nodeDepth(depth, nodeToIdx, 'A'), 2);
    assert.equal(nodeDepth(depth, nodeToIdx, 'B'), 2);
    assert.equal(nodeDepth(depth, nodeToIdx, 'C'), 1);
    assert.equal(nodeDepth(depth, nodeToIdx, 'D'), 0);
  });

  test('disconnected components: each component depths computed independently', () => {
    const graph = buildGraph([['A', 'B'], ['C', 'D'], ['D', 'E']]);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);
    const depth = computeTopologicalDepth(dag);

    const nodeToIdx = mapNodesToSccIndices(sccs);

    // A→B: A=1, B=0
    assert.equal(nodeDepth(depth, nodeToIdx, 'A'), 1);
    assert.equal(nodeDepth(depth, nodeToIdx, 'B'), 0);
    // C→D→E: C=2, D=1, E=0
    assert.equal(nodeDepth(depth, nodeToIdx, 'C'), 2);
    assert.equal(nodeDepth(depth, nodeToIdx, 'D'), 1);
    assert.equal(nodeDepth(depth, nodeToIdx, 'E'), 0);
  });

  test('isolated node has depth 0', () => {
    const graph = buildGraph([['A', 'B']]);
    ensureNodes(graph, ['C']);
    const sccs = findSCCs(graph);
    const dag = condenseToDAG(graph, sccs);
    const depth = computeTopologicalDepth(dag);

    const nodeToIdx = mapNodesToSccIndices(sccs);

    assert.equal(nodeDepth(depth, nodeToIdx, 'C'), 0);
  });
});

describe('computeLeafDistanceMatrix', () => {
  test('computes minimum undirected edge counts between leaves', () => {
    const dag = new Map<number, Set<number>>([
      [0, new Set([1, 2])],
      [1, new Set([3])],
      [2, new Set([4])],
      [3, new Set()],
      [4, new Set()],
    ]);

    const distances = computeLeafDistanceMatrix(dag);
    const rowThree = distances.get(3);
    const rowFour = distances.get(4);

    if (rowThree === undefined || rowFour === undefined) {
      throw new Error('Expected rows for both leaf SCCs');
    }

    assert.equal(rowThree.get(3), 0);
    assert.equal(rowFour.get(4), 0);
    assert.equal(rowThree.get(4), 4);
    assert.equal(rowFour.get(3), 4);
  });

  test('marks leaves in different disconnected components as unreachable', () => {
    const dag = new Map<number, Set<number>>([
      [0, new Set([1])],
      [1, new Set()],
      [2, new Set([3])],
      [3, new Set()],
    ]);

    const distances = computeLeafDistanceMatrix(dag);
    const rowOne = distances.get(1);
    const rowThree = distances.get(3);

    if (rowOne === undefined || rowThree === undefined) {
      throw new Error('Expected rows for disconnected leaf SCCs');
    }

    assert.equal(rowOne.get(3), null);
    assert.equal(rowThree.get(1), null);
  });
});

describe('partitionLeafSccsByDistance', () => {
  test('splits leaves to maximize cross-cluster leaf distance', () => {
    const dag = new Map<number, Set<number>>([
      [0, new Set([1, 2])],
      [1, new Set([3])],
      [2, new Set([4])],
      [3, new Set()],
      [4, new Set()],
    ]);

    const partition = partitionLeafSccsByDistance(dag);

    assert.deepEqual(partition.clusterA, [3]);
    assert.deepEqual(partition.clusterB, [4]);
    assert.equal(partition.crossClusterDistanceSum, 4);
  });

  test('returns one empty cluster when fewer than two leaves exist', () => {
    const dag = new Map<number, Set<number>>([
      [0, new Set([1])],
      [1, new Set()],
    ]);

    const partition = partitionLeafSccsByDistance(dag);

    assert.deepEqual(partition.clusterA, [1]);
    assert.deepEqual(partition.clusterB, []);
    assert.equal(partition.crossClusterDistanceSum, 0);
  });
});
