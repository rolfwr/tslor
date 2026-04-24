import { assert, describe, test } from 'vitest';
import { ObjStore } from './objstore';
import { Storage } from './storage';
import {
  buildHotModuleGraph,
  calculateAllScores,
  selectHotModule,
  buildImportedByChain,
  buildImportChain,
} from './runHot';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStorage(edges: Array<{ from: string; to: string }>): Storage {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, '/dev/null', { traceId: null }, false);
  let idx = 0;
  for (const { from, to } of edges) {
    storage.putImport(from, '/tsconfig.json', idx++, 'sym', {
      path: to,
      tsconfig: '/tsconfig.json',
    });
  }
  return storage;
}

// ---------------------------------------------------------------------------
// buildHotModuleGraph
// ---------------------------------------------------------------------------

describe('buildHotModuleGraph', () => {
  test('builds imports and importedBy for a linear chain A→B→C', () => {
    // "A imports from B" means A is the consumer, B is the exporter.
    // In storage: putImport(A, ..., sym, {path: B}) → A's exporter is B.
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);

    const filePaths = ['/a.ts', '/b.ts', '/c.ts'];
    const hotMods = buildHotModuleGraph(db, filePaths);

    // A imports B
    assert.deepEqual(hotMods['/a.ts']!.imports, ['/b.ts']);
    assert.deepEqual(hotMods['/a.ts']!.importedBy, []);

    // B imports C, is imported by A
    assert.deepEqual(hotMods['/b.ts']!.imports, ['/c.ts']);
    assert.deepEqual(hotMods['/b.ts']!.importedBy, ['/a.ts']);

    // C is imported by B
    assert.deepEqual(hotMods['/c.ts']!.imports, []);
    assert.deepEqual(hotMods['/c.ts']!.importedBy, ['/b.ts']);
  });

  test('ignores imports to files outside the provided filePaths set', () => {
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/a.ts', to: '/external.ts' }, // not in scope
    ]);

    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts']);

    assert.deepEqual(hotMods['/a.ts']!.imports, ['/b.ts']);
    assert.isUndefined(hotMods['/external.ts']);
  });
});

// ---------------------------------------------------------------------------
// calculateAllScores
// ---------------------------------------------------------------------------

describe('calculateAllScores', () => {
  test('assigns finite badness to all modules', () => {
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts', '/c.ts']);
    calculateAllScores(hotMods);

    for (const path of ['/a.ts', '/b.ts', '/c.ts']) {
      const m = hotMods[path]!;
      assert.isNotNull(m.badness, `${path} should have a badness score`);
      assert.isFinite(m.badness!);
    }
  });

  test('middle node in a chain is hotter than the leaf nodes', () => {
    // A→B→C: B is both imported and imports, so it should score highest
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts', '/c.ts']);
    calculateAllScores(hotMods);

    assert.isAbove(hotMods['/b.ts']!.badness!, hotMods['/a.ts']!.badness!);
    assert.isAbove(hotMods['/b.ts']!.badness!, hotMods['/c.ts']!.badness!);
  });
});

// ---------------------------------------------------------------------------
// selectHotModule
// ---------------------------------------------------------------------------

describe('selectHotModule', () => {
  test('returns null (not throws) when hotArray is empty', () => {
    const result = selectHotModule({}, [], { select: null });
    assert.isNull(result);
  });

  test('returns the first element of hotArray when no select option', () => {
    const db = makeStorage([{ from: '/a.ts', to: '/b.ts' }]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts']);
    calculateAllScores(hotMods);
    const hotArray = Object.values(hotMods).sort((a, b) => b.badness! - a.badness!);

    const result = selectHotModule(hotMods, hotArray, { select: null });
    assert.strictEqual(result, hotArray[0]);
  });

  test('returns the named module when options.select is set', () => {
    const db = makeStorage([{ from: '/a.ts', to: '/b.ts' }]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts']);
    calculateAllScores(hotMods);

    const result = selectHotModule(hotMods, [], { select: '/b.ts' });
    assert.strictEqual(result!.path, '/b.ts');
  });

  test('throws when options.select names a module not in the graph', () => {
    assert.throws(
      () => selectHotModule({}, [], { select: '/missing.ts' }),
      /Module not found/
    );
  });
});

// ---------------------------------------------------------------------------
// buildImportedByChain / buildImportChain
// ---------------------------------------------------------------------------

describe('buildImportedByChain', () => {
  test('walks upward from selected along the hottest importers', () => {
    // Graph: X→A→B  (A is imported by X, B is imported by A)
    // selected = A.  Up-chain should visit X (the importer of A).
    const db = makeStorage([
      { from: '/x.ts', to: '/a.ts' },
      { from: '/a.ts', to: '/b.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/x.ts', '/a.ts', '/b.ts']);
    calculateAllScores(hotMods);

    const selected = hotMods['/a.ts']!;
    const chain = buildImportedByChain(hotMods, selected);

    assert.deepEqual(
      chain.map((m) => m.path),
      ['/x.ts']
    );
  });

  test('selected node does not appear in the up-chain (cycle guard)', () => {
    // Cycle: A imports B, B imports A.  Starting from A, up-chain
    // should NOT contain A again.
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/a.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts']);
    calculateAllScores(hotMods);

    const selected = hotMods['/a.ts']!;
    const chain = buildImportedByChain(hotMods, selected);

    assert.notInclude(
      chain.map((m) => m.path),
      '/a.ts',
      'selected should not appear in its own up-chain'
    );
  });
});

describe('buildImportChain', () => {
  test('walks downward from selected along the hottest imports', () => {
    // Graph: X→A→B  selected = A.  Down-chain should visit B.
    const db = makeStorage([
      { from: '/x.ts', to: '/a.ts' },
      { from: '/a.ts', to: '/b.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/x.ts', '/a.ts', '/b.ts']);
    calculateAllScores(hotMods);

    const selected = hotMods['/a.ts']!;
    const chain = buildImportChain(hotMods, selected);

    assert.deepEqual(
      chain.map((m) => m.path),
      ['/b.ts']
    );
  });

  test('selected node does not appear in the down-chain (cycle guard)', () => {
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/a.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts']);
    calculateAllScores(hotMods);

    const selected = hotMods['/a.ts']!;
    const chain = buildImportChain(hotMods, selected);

    assert.notInclude(
      chain.map((m) => m.path),
      '/a.ts',
      'selected should not appear in its own down-chain'
    );
  });
});

// ---------------------------------------------------------------------------
// hotChain composition
// ---------------------------------------------------------------------------

describe('hotChain composition', () => {
  test('full chain has no duplicate paths for a linear graph', () => {
    // X→A→B→C: selected = A.  hotChain = [X, A, B, C].
    const db = makeStorage([
      { from: '/x.ts', to: '/a.ts' },
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);
    const filePaths = ['/x.ts', '/a.ts', '/b.ts', '/c.ts'];
    const hotMods = buildHotModuleGraph(db, filePaths);
    calculateAllScores(hotMods);

    const selected = hotMods['/a.ts']!;
    const importedByChain = buildImportedByChain(hotMods, selected);
    const importChain = buildImportChain(hotMods, selected);
    const hotChain = [...importedByChain.reverse(), selected, ...importChain];

    const paths = hotChain.map((m) => m.path);
    const uniquePaths = [...new Set(paths)];
    assert.deepEqual(paths, uniquePaths, 'hotChain should have no duplicate entries');
  });
});
