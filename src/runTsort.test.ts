import { ObjStore } from './objstore';
import { Storage } from './storage';
import { getOrThrow, invariant } from './invariant';
import { assert, test, describe } from 'vitest';

describe('tsort', () => {
  // Helper to create a storage with import relationships
  function createStorageWithImports(imports: Array<{ from: string; to: string }>) {
    const objStore = new ObjStore({ traceId: null });
    const storage = new Storage(objStore, { jsonlPath: '/dev/null', verbose: false, inMemory: true });

    let index = 0;
    for (const { from, to } of imports) {
      storage.putImport(from, '/tsconfig.json', index++, 'symbol', { path: to, tsconfig: '/tsconfig.json' });
    }

    return storage;
  }

  function buildGraphs(storage: Storage, moduleSet: Set<string>) {
    const graph = new Map<string, Set<string>>();
    const reverseGraph = new Map<string, Set<string>>();
    for (const modulePath of moduleSet) {
      graph.set(modulePath, new Set());
      reverseGraph.set(modulePath, new Set());
    }
    for (const modulePath of moduleSet) {
      addEdgesForModule(modulePath, storage, moduleSet, graph, reverseGraph);
    }
    return { graph, reverseGraph };
  }

  function addEdgesForModule(
    modulePath: string,
    storage: Storage,
    moduleSet: Set<string>,
    graph: Map<string, Set<string>>,
    reverseGraph: Map<string, Set<string>>
  ): void {
    const exporters = storage.getExporterPathsOfImport(modulePath);
    for (const exporter of exporters) {
      if (!moduleSet.has(exporter.path)) {
        continue;
      }
      getOrThrow(graph, exporter.path, 'exporter.path not in graph').add(modulePath);
      getOrThrow(reverseGraph, modulePath, 'modulePath not in reverseGraph').add(exporter.path);
    }
  }

  function insertSorted(queue: string[], item: string): void {
    const insertIndex = queue.findIndex(q => q > item);
    if (insertIndex === -1) {
      queue.push(item);
    } else {
      queue.splice(insertIndex, 0, item);
    }
  }

  function processKahnQueue(
    queue: string[],
    graph: Map<string, Set<string>>,
    inDegree: Map<string, number>,
    result: string[]
  ): void {
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      result.push(current);
      processNodeDependents(current, graph, inDegree, queue);
    }
  }

  function processNodeDependents(
    current: string,
    graph: Map<string, Set<string>>,
    inDegree: Map<string, number>,
    queue: string[]
  ): void {
    for (const dependent of getOrThrow(graph, current, 'current not in graph')) {
      const dependentInDegree = inDegree.get(dependent);
      if (dependentInDegree === undefined) {
        continue;
      }
      const newInDegree = dependentInDegree - 1;
      inDegree.set(dependent, newInDegree);
      if (newInDegree === 0) {
        insertSorted(queue, dependent);
      }
    }
  }

  function kahnSort(
    moduleSet: Set<string>,
    graph: Map<string, Set<string>>,
    reverseGraph: Map<string, Set<string>>
  ): string[] | null {
    const inDegree = new Map<string, number>();
    for (const modulePath of moduleSet) {
      inDegree.set(modulePath, getOrThrow(reverseGraph, modulePath, 'modulePath not in reverseGraph').size);
    }
    const queue: string[] = [];
    for (const modulePath of moduleSet) {
      if (inDegree.get(modulePath) === 0) {
        queue.push(modulePath);
      }
    }
    queue.sort();
    const result: string[] = [];
    processKahnQueue(queue, graph, inDegree, result);
    return result.length < moduleSet.size ? null : result;
  }

  // Helper to perform topological sort on a storage
  function performTsort(storage: Storage, modules: string[]): string[] | null {
    const moduleSet = new Set(modules);
    const { graph, reverseGraph } = buildGraphs(storage, moduleSet);
    return kahnSort(moduleSet, graph, reverseGraph);
  }

  test('linear dependency chain (A→B→C) outputs C, B, A', () => {
    // A imports B, B imports C
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);

    const result = performTsort(storage, ['/a.ts', '/b.ts', '/c.ts']);

    invariant(result !== null, 'Expected valid topological sort');
    assert.deepEqual(result, ['/c.ts', '/b.ts', '/a.ts']);

    // Verify dependency order: C should appear before B, B before A
    const aIndex = result.indexOf('/a.ts');
    const bIndex = result.indexOf('/b.ts');
    const cIndex = result.indexOf('/c.ts');

    assert.isTrue(cIndex < bIndex, 'C (no imports) should come before B');
    assert.isTrue(bIndex < aIndex, 'B (which imports C) should come before A');
  });

  test('diamond dependency outputs dependencies before dependents', () => {
    // A imports B and C, B imports D, C imports D
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/a.ts', to: '/c.ts' },
      { from: '/b.ts', to: '/d.ts' },
      { from: '/c.ts', to: '/d.ts' },
    ]);

    const result = performTsort(storage, ['/a.ts', '/b.ts', '/c.ts', '/d.ts']);

    invariant(result !== null, 'Expected valid topological sort');

    // Verify dependency order: D before B and C, B and C before A
    const aIndex = result.indexOf('/a.ts');
    const bIndex = result.indexOf('/b.ts');
    const cIndex = result.indexOf('/c.ts');
    const dIndex = result.indexOf('/d.ts');

    assert.isTrue(dIndex < bIndex, 'D (no imports) should come before B');
    assert.isTrue(dIndex < cIndex, 'D (no imports) should come before C');
    assert.isTrue(bIndex < aIndex, 'B should come before A');
    assert.isTrue(cIndex < aIndex, 'C should come before A');
  });

  test('independent modules output in consistent alphabetical order', () => {
    // No dependencies between modules
    const storage = createStorageWithImports([]);

    const result = performTsort(storage, ['/c.ts', '/a.ts', '/b.ts']);

    invariant(result !== null, 'Expected valid topological sort');
    // Should be sorted alphabetically since no dependencies
    assert.deepEqual(result, ['/a.ts', '/b.ts', '/c.ts']);
  });

  test('single module outputs just that module', () => {
    const storage = createStorageWithImports([]);

    const result = performTsort(storage, ['/only.ts']);

    invariant(result !== null, 'Expected valid topological sort');
    assert.deepEqual(result, ['/only.ts']);
  });

  test('cycle detection returns null', () => {
    // A imports B, B imports C, C imports A (cycle)
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
      { from: '/c.ts', to: '/a.ts' },
    ]);

    const result = performTsort(storage, ['/a.ts', '/b.ts', '/c.ts']);

    assert.isNull(result, 'Should return null when cycle detected');
  });

  test('external dependencies are ignored', () => {
    // A imports B, A imports external (not in input set)
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/a.ts', to: '/external.ts' },
      { from: '/b.ts', to: '/another-external.ts' },
    ]);

    // Only ask for A and B, ignoring external
    const result = performTsort(storage, ['/a.ts', '/b.ts']);

    invariant(result !== null, 'Expected valid topological sort');
    assert.deepEqual(result, ['/b.ts', '/a.ts']);

    const aIndex = result.indexOf('/a.ts');
    const bIndex = result.indexOf('/b.ts');
    assert.isTrue(bIndex < aIndex, 'B (dependency) should come before A');
  });

  test('self-import is treated as cycle', () => {
    // A imports itself
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/a.ts' },
    ]);

    const result = performTsort(storage, ['/a.ts']);

    assert.isNull(result, 'Self-import should be detected as cycle');
  });

  test('partial cycle in larger graph', () => {
    // A imports B, B imports C, C imports B (B-C cycle), D independent
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
      { from: '/c.ts', to: '/b.ts' },
    ]);

    const result = performTsort(storage, ['/a.ts', '/b.ts', '/c.ts', '/d.ts']);

    assert.isNull(result, 'Should detect cycle even with unrelated nodes');
  });

  test('empty input produces empty output', () => {
    const storage = createStorageWithImports([]);

    const result = performTsort(storage, []);

    invariant(result !== null, 'Expected valid topological sort');
    assert.deepEqual(result, []);
  });
});
