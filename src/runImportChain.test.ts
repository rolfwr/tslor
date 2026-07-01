import { ObjStore } from './objstore';
import { Storage } from './storage';
import {
  buildImportChain,
  getImportChainDown,
  pickNextNode,
  type NodeInfo,
} from './runImportChain';
import { assert, test, describe } from 'vitest';

/**
 * Build a Storage pre-populated with import relationships.
 *
 * Convention: `putImport(importer, tsconfig, index, symbol, { path: exporter })`
 * means "importer imports symbol from exporter".
 *
 * For import-chain, we walk *upward* from `fromPath`: we find who imports
 * `fromPath`, then who imports those, etc., until we reach `toPath`.
 */
function createStorageWithImports(
  imports: Array<{ from: string; to: string }>,
): Storage {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, {
    jsonlPath: '/dev/null',
    verbose: false,
    inMemory: true,
  });

  let index = 0;
  for (const { from, to } of imports) {
    storage.putImport(from, '/tsconfig.json', index++, 'sym', {
      path: to,
      tsconfig: '/tsconfig.json',
    });
  }

  return storage;
}

function runChain(
  storage: Storage,
  fromPath: string,
  toPath: string,
): string[] {
  const chain: string[] = [];
  let node: NodeInfo | null = getImportChainDown(
    storage,
    new Map(),
    fromPath,
    toPath,
  );

  while (node) {
    chain.push(node.id);
    node = pickNextNode(node);
  }

  return chain;
}

describe('import-chain cycle protection', () => {
  test('diamond dependency (A→B→C, A→D→C) completes without OOM', () => {
    /*
      Dependency graph (importer → imported):
        A → B, A → D
        B → C
        D → C
        C → target

      Walking upward from `target`:
        target is imported by C
        C is imported by B and D
        B is imported by A, D is imported by A

      Expected chain: target → C → B (or D) → A
    */
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/a.ts', to: '/d.ts' },
      { from: '/b.ts', to: '/c.ts' },
      { from: '/d.ts', to: '/c.ts' },
      { from: '/c.ts', to: '/target.ts' },
    ]);

    const chain = runChain(storage, '/target.ts', '/a.ts');

    assert.equal(chain[0], '/target.ts', 'Chain starts at target');
    assert.equal(chain[chain.length - 1], '/a.ts', 'Chain ends at A');

    const seen = new Set(chain);
    assert.equal(seen.size, chain.length, 'No duplicate nodes in chain');
  });

  test('unreachable target — BFS traverses cycle (A↔B) and terminates', () => {
    /*
      Dependency graph:
        A → B
        B → A (cycle)
        A → target

      Walking from target toward /c.ts (unreachable):
        target is imported by A
        A is imported by B
        B is imported by A — cycle, visited set prevents re-entry

      /c.ts is never found; chain terminates with node.down === null.
    */
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/a.ts' },
      { from: '/a.ts', to: '/target.ts' },
    ]);

    const chain = runChain(storage, '/target.ts', '/c.ts');

    assert.isFalse(
      chain.includes('/c.ts'),
      'Unreachable target must not appear in chain',
    );
  });

  test('complex diamond with shared intermediate completes without revisiting', () => {
    /*
      Dependency graph:
        A → B, A → C, A → D
        B → E, B → F
        C → E, C → F
        D → E, D → F
        E → target
        F → target

      Without visited-set protection, E and F would be visited 3 times each
      (once from B, C, D). With iterative BFS, each is visited once.
    */
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/a.ts', to: '/c.ts' },
      { from: '/a.ts', to: '/d.ts' },
      { from: '/b.ts', to: '/e.ts' },
      { from: '/b.ts', to: '/f.ts' },
      { from: '/c.ts', to: '/e.ts' },
      { from: '/c.ts', to: '/f.ts' },
      { from: '/d.ts', to: '/e.ts' },
      { from: '/d.ts', to: '/f.ts' },
      { from: '/e.ts', to: '/target.ts' },
      { from: '/f.ts', to: '/target.ts' },
    ]);

    const chain = runChain(storage, '/target.ts', '/a.ts');

    assert.equal(chain[0], '/target.ts', 'Chain starts at target');
    assert.equal(chain[chain.length - 1], '/a.ts', 'Chain ends at A');

    const seen = new Set(chain);
    assert.equal(seen.size, chain.length, 'No duplicate nodes');
  });

  test('deep chain (A→B→C→D→E→target) completes correctly', () => {
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/c.ts' },
      { from: '/c.ts', to: '/d.ts' },
      { from: '/d.ts', to: '/e.ts' },
      { from: '/e.ts', to: '/target.ts' },
    ]);

    const chain = runChain(storage, '/target.ts', '/a.ts');

    assert.deepEqual(chain, [
      '/target.ts',
      '/e.ts',
      '/d.ts',
      '/c.ts',
      '/b.ts',
      '/a.ts',
    ]);
  });

  test('no path exists — chain terminates when target unreachable', () => {
    /*
      A imports B, but nothing imports A. Starting from B,
      we find A imports B, but A has no path to an unreachable target.
    */
    const storage = createStorageWithImports([{ from: '/a.ts', to: '/b.ts' }]);

    const chain = runChain(storage, '/b.ts', '/c.ts');

    assert.isTrue(
      chain.length <= 1,
      'Chain should contain only the starting node when no path exists',
    );
  });
});

describe('buildImportChain', () => {
  test('returns chain when path exists', () => {
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
      { from: '/b.ts', to: '/target.ts' },
    ]);

    const result = buildImportChain(storage, '/target.ts', '/a.ts');

    assert.isTrue(result.found, 'Should report path found');
    assert.deepEqual(result.chain, ['/target.ts', '/b.ts', '/a.ts']);
  });

  test('reports not found when target is unreachable', () => {
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
    ]);

    const result = buildImportChain(storage, '/b.ts', '/c.ts');

    assert.isFalse(result.found, 'Should report path not found');
    assert.deepEqual(result.chain, ['/b.ts']);
  });

  test('reports not found when fromPath has no importers', () => {
    /*
      /leaf.ts imports nothing and nothing imports /leaf.ts.
      Starting BFS from /leaf.ts can find no importers, so any
      other target is unreachable.
    */
    const storage = createStorageWithImports([
      { from: '/a.ts', to: '/b.ts' },
    ]);

    const result = buildImportChain(storage, '/leaf.ts', '/a.ts');

    assert.isFalse(result.found, 'Should report path not found');
    assert.deepEqual(result.chain, ['/leaf.ts']);
  });
});
