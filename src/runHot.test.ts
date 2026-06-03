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

/* Helpers */

function mustGet<K extends string, V>(record: Record<K, V>, key: K): V {
  const v = record[key];
  if (v === undefined) {
    throw new Error(`Expected ${key} to exist in record`);
  }
  return v;
}

function makeStorage(
  edges: Array<{
    from: string;
    to: string;
    fromTsconfig?: string;
    toTsconfig?: string;
  }>
): Storage {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, '/dev/null', { traceId: null }, false);
  let idx = 0;
  for (const { from, to, fromTsconfig, toTsconfig } of edges) {
    storage.putImport(
      from,
      fromTsconfig ?? '/tsconfig.json',
      idx++,
      'sym',
      {
        path: to,
        tsconfig: toTsconfig ?? '/tsconfig.json',
      }
    );
  }
  return storage;
}

describe('buildHotModuleGraph', () => {
  test('builds imports and importedBy for a linear chain A→B→C', () => {
    /*
      "A imports from B" means A is the consumer, B is the exporter.
      In storage: putImport(A, ..., sym, {path: B}) → A's exporter is B.
    */
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);

    const filePaths = ['/a.ts', '/b.ts', '/c.ts'];
    const hotMods = buildHotModuleGraph(db, filePaths, undefined);

    assert.deepEqual(mustGet(hotMods, '/a.ts').imports, ['/b.ts']);
    assert.deepEqual(mustGet(hotMods, '/a.ts').importedBy, []);

    assert.deepEqual(mustGet(hotMods, '/b.ts').imports, ['/c.ts']);
    assert.deepEqual(mustGet(hotMods, '/b.ts').importedBy, ['/a.ts']);

    assert.deepEqual(mustGet(hotMods, '/c.ts').imports, []);
    assert.deepEqual(mustGet(hotMods, '/c.ts').importedBy, ['/b.ts']);
  });

  test('ignores imports to files outside the provided filePaths set', () => {
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/a.ts', to: '/external.ts' }, // not in scope
    ]);

    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts'], undefined);

    assert.deepEqual(mustGet(hotMods, '/a.ts').imports, ['/b.ts']);
    assert.isUndefined(hotMods['/external.ts']);
  });
});

describe('calculateAllScores', () => {
  test('assigns finite badness to all modules', () => {
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts', '/c.ts'], undefined);
    const scored = calculateAllScores(hotMods);

    for (const path of ['/a.ts', '/b.ts', '/c.ts']) {
      const m = mustGet(scored, path);
      assert.isFinite(m.badness);
    }
  });

  test('middle node in a chain is hotter than the leaf nodes', () => {
    // A→B→C: B is both imported and imports, so it should score highest.
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts', '/c.ts'], undefined);
    const scored = calculateAllScores(hotMods);

    assert.isAbove(mustGet(scored, '/b.ts').badness, mustGet(scored, '/a.ts').badness);
    assert.isAbove(mustGet(scored, '/b.ts').badness, mustGet(scored, '/c.ts').badness);
  });
});

describe('selectHotModule', () => {
  test('throws when hotArray is empty', () => {
    assert.throws(
      () => selectHotModule({}, [], { select: null }),
      /No modules in hot array/
    );
  });

  test('returns the first element of hotArray when no select option', () => {
    const db = makeStorage([{ from: '/a.ts', to: '/b.ts' }]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts'], undefined);
    const scored = calculateAllScores(hotMods);
    const hotArray = Object.values(scored).sort((a, b) => b.badness - a.badness);

    const result = selectHotModule(scored, hotArray, { select: null });
    assert.strictEqual(result, hotArray.at(0));
  });

  test('returns the named module when options.select is set', () => {
    const db = makeStorage([{ from: '/a.ts', to: '/b.ts' }]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts'], undefined);
    const scored = calculateAllScores(hotMods);

    const result = selectHotModule(scored, [], { select: '/b.ts' });
    assert.strictEqual(result.path, '/b.ts');
  });

  test('throws when options.select names a module not in the graph', () => {
    assert.throws(
      () => selectHotModule({}, [], { select: '/missing.ts' }),
      /Module not found/
    );
  });
});

describe('buildImportedByChain', () => {
  test('walks upward from selected along the hottest importers', () => {
    /*
      Graph: X→A→B  (A is imported by X, B is imported by A)
      selected = A.  Up-chain should visit X (the importer of A).
    */
    const db = makeStorage([
      { from: '/x.ts', to: '/a.ts' },
      { from: '/a.ts', to: '/b.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/x.ts', '/a.ts', '/b.ts'], undefined);
    const scored = calculateAllScores(hotMods);

    const selected = mustGet(scored, '/a.ts');
    const chain = buildImportedByChain(scored, selected);

    assert.deepEqual(
      chain.map((m) => m.path),
      ['/x.ts']
    );
  });

  test('selected node does not appear in the up-chain (cycle guard)', () => {
    /*
      Cycle: A imports B, B imports A.  Starting from A, up-chain
      should NOT contain A again.
    */
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/a.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts'], undefined);
    const scored = calculateAllScores(hotMods);

    const selected = mustGet(scored, '/a.ts');
    const chain = buildImportedByChain(scored, selected);

    assert.notInclude(
      chain.map((m) => m.path),
      '/a.ts',
      'selected should not appear in its own up-chain'
    );
  });
});

describe('buildImportChain', () => {
  test('walks downward from selected along the hottest imports', () => {
    /*
      Graph: X→A→B  selected = A.  Down-chain should visit B.
    */
    const db = makeStorage([
      { from: '/x.ts', to: '/a.ts' },
      { from: '/a.ts', to: '/b.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/x.ts', '/a.ts', '/b.ts'], undefined);
    const scored = calculateAllScores(hotMods);

    const selected = mustGet(scored, '/a.ts');
    const chain = buildImportChain(scored, selected);

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
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts'], undefined);
    const scored = calculateAllScores(hotMods);

    const selected = mustGet(scored, '/a.ts');
    const chain = buildImportChain(scored, selected);

    assert.notInclude(
      chain.map((m) => m.path),
      '/a.ts',
      'selected should not appear in its own down-chain'
    );
  });
});

describe('hotChain composition', () => {
  test('full chain has no duplicate paths for a linear graph', () => {
    // X→A→B→C: selected = A.  hotChain = [X, A, B, C].
    const db = makeStorage([
      { from: '/x.ts', to: '/a.ts' },
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
    ]);
    const filePaths = ['/x.ts', '/a.ts', '/b.ts', '/c.ts'];
    const hotMods = buildHotModuleGraph(db, filePaths, undefined);
    const scored = calculateAllScores(hotMods);

    const selected = mustGet(scored, '/a.ts');
    const importedByChain = buildImportedByChain(scored, selected);
    const importChain = buildImportChain(scored, selected);
    const hotChain = [...importedByChain.reverse(), selected, ...importChain];

    const paths = hotChain.map((m) => m.path);
    const uniquePaths = [...new Set(paths)];
    assert.deepEqual(paths, uniquePaths, 'hotChain should have no duplicate entries');
  });
});

describe('buildHotModuleGraph with project-scope', () => {
  test('includes all imports when moduleTsconfigMap is undefined', () => {
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/a.ts', to: '/c.ts' },
    ]);
    const hotMods = buildHotModuleGraph(db, ['/a.ts', '/b.ts', '/c.ts'], undefined);

    assert.deepEqual(mustGet(hotMods, '/a.ts').imports, ['/b.ts', '/c.ts']);
  });

  test('excludes cross-project imports per-module when moduleTsconfigMap is set', () => {
    /*
      /a.ts (project A) imports /b.ts (project A) and /c.ts (project B).
      With project-scope, /a.ts should only import /b.ts (same project).
    */
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts', fromTsconfig: '/project/tsconfig.json', toTsconfig: '/project/tsconfig.json' },
      { from: '/a.ts', to: '/c.ts', fromTsconfig: '/project/tsconfig.json', toTsconfig: '/other/tsconfig.json' },
    ]);

    const moduleTsconfigMap = new Map([
      ['/a.ts', '/project/tsconfig.json'],
      ['/b.ts', '/project/tsconfig.json'],
      ['/c.ts', '/other/tsconfig.json'],
    ]);

    const hotMods = buildHotModuleGraph(
      db,
      ['/a.ts', '/b.ts', '/c.ts'],
      moduleTsconfigMap
    );

    assert.deepEqual(mustGet(hotMods, '/a.ts').imports, ['/b.ts']);
    // /c.ts is still in the graph (it's in filePaths) but not imported by /a.ts
    assert.isDefined(hotMods['/c.ts']);
  });

  test('excludes all imports when none share the tsconfig', () => {
    const db = makeStorage([
      { from: '/a.ts', to: '/b.ts', fromTsconfig: '/project/tsconfig.json', toTsconfig: '/other/tsconfig.json' },
    ]);

    const moduleTsconfigMap = new Map([
      ['/a.ts', '/project/tsconfig.json'],
      ['/b.ts', '/other/tsconfig.json'],
    ]);

    const hotMods = buildHotModuleGraph(
      db,
      ['/a.ts', '/b.ts'],
      moduleTsconfigMap
    );

    assert.deepEqual(mustGet(hotMods, '/a.ts').imports, []);
  });
});
