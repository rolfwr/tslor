/**
 * Coupling analysis tests
 *
 * Tests buildClassCouplingGraph and buildModuleCouplingGraph using in-memory
 * source, and runCoupling output using temp files (needed for path in output).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, test } from 'vitest';
import { createTempDir, createTestSourceFile } from './testUtils';
import {
  buildClassCouplingGraph,
  buildModuleCouplingGraph,
  runCoupling,
  type CouplingGraph,
  type RunCouplingOptions,
} from './runCoupling';

function parseClassCouplingFromSource(
  sourceCode: string,
  className: string,
): CouplingGraph {
  const sourceFile = createTestSourceFile(sourceCode);
  const classDeclaration = sourceFile.getClass(className);
  if (classDeclaration === undefined) {
    throw new Error(`Class ${className} not found`);
  }

  return buildClassCouplingGraph(classDeclaration);
}

function normalizeGraph(graph: CouplingGraph): Record<string, string[]> {
  return Object.fromEntries(
    [...graph.entries()]
      .map(([name, deps]): [string, string[]] => [name, [...deps].sort()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function withFile(
  sourceCode: string,
  testBody: (filePath: string) => void,
): void {
  const { dir, cleanup } = createTempDir();
  const filePath = join(dir, 'test.ts');

  try {
    writeFileSync(filePath, sourceCode);
    testBody(filePath);
  } finally {
    cleanup();
  }
}

function runCouplingWithOutput(
  filePath: string,
  options?: Omit<RunCouplingOptions, 'output'>,
): string {
  const chunks: string[] = [];
  runCoupling(filePath, {
    ...options,
    output: { write: (text) => chunks.push(text) },
  });
  return chunks.join('');
}

describe('parseClassCoupling', () => {
  test('parses class members, field initializers, accessors, and arrow bodies', () => {
    const graph = parseClassCouplingFromSource(
      `
class Mixed {
  private count = 0;
  private base = 1;
  private doubled = this.base * 2;
  private tripled = this.doubled + this.base;
  private state = { timed: 1, dirty: false };

  private readonly onTick = () => {
    this.count = this.compute();
    this.onTick();
  };

  constructor() {
    this.init();
    this.count = this.compute();
  }

  private init(): void {
    this.onTick();
    this.count = this.count + 1;
  }

  private compute(): number {
    return this.count;
  }

  private get timed() { return this.state.timed; }
  private set timed(v: number) { this.state.timed = v; }
  private readonly read = () => this.base;
  private readonly trigger = () => this.read();

  private untouched(): void {
    this.unknown;
    this.untouched();
  }
}
`,
      'Mixed',
    );
    const normalized = normalizeGraph(graph);

    assert.deepEqual(normalized.compute, ['count']);
    assert.deepEqual(normalized['constructor'], ['compute', 'count', 'init']);
    assert.deepEqual(normalized.init, ['count', 'onTick']);
    assert.deepEqual(normalized.onTick, ['compute', 'count']);
    assert.deepEqual(normalized.doubled, ['base']);
    assert.deepEqual(normalized.tripled, ['base', 'doubled']);
    assert.deepEqual(normalized.timed, ['state']);
    assert.deepEqual(normalized.read, ['base']);
    assert.deepEqual(normalized.trigger, ['read']);
    assert.deepEqual(normalized.untouched, []);
  });

  test('ignores this.X from nested non-arrow scopes', () => {
    const graph = parseClassCouplingFromSource(
      `
class NestedScopes {
  private count = 0;

  private wrapper(): void {
    const callback = function(this: { count: number }): void {
      this.count = this.count + 1;
    };

    class Local {
      private count = 0;
      private readonly update = () => { this.count = this.count + 1; };
      run(): void { this.count = this.count + 1; this.update(); }
    }

    callback.call({ count: 1 });
    void Local;
  }
}
`,
      'NestedScopes',
    );

    assert.deepEqual(normalizeGraph(graph), {
      count: [],
      wrapper: [],
    });
  });
});

describe('parseModuleCoupling', () => {
  test('parses module declarations with class initializers and destructuring', () => {
    const graph = buildModuleCouplingGraph(
      createTestSourceFile(
        `
import { externalThing } from './external';

const shared = 1;
const makeShared = () => shared;
const derived = shared + 1;
const first = 1, second = () => makeShared();
const helper = () => 0;

interface ModuleShape { value: number; }
type ModuleId = string;

class Worker {
  private value = shared;
  private readonly read = () => makeShared();
  constructor() { void shared; }
  run(): number { return makeShared(); }
  static create(): Worker { return new Worker(); }
  static { void shared; void helper(); }
}

function orchestrate(): number {
  void externalThing;
  return makeShared() + shared + Math.max(1, 2);
}

function recursive(): number { return recursive(); }

const source = { alpha: 1, beta: 2 };
const { alpha, beta: renamedBeta } = source;
function readAlpha(): number { return alpha; }
function readRenamedBeta(): number { return renamedBeta; }
`,
      ),
    );
    const normalized = normalizeGraph(graph);

    assert.deepEqual(normalized.Worker, ['helper', 'makeShared', 'shared']);
    assert.deepEqual(normalized.makeShared, ['shared']);
    assert.deepEqual(normalized.orchestrate, ['makeShared', 'shared']);
    assert.deepEqual(normalized.derived, ['shared']);
    assert.deepEqual(normalized.second, ['makeShared']);
    assert.deepEqual(normalized.alpha, ['source']);
    assert.deepEqual(normalized.renamedBeta, ['source']);
    assert.deepEqual(normalized.readAlpha, ['alpha']);
    assert.deepEqual(normalized.readRenamedBeta, ['renamedBeta']);
    assert.deepEqual(normalized.recursive, []);
    assert.deepEqual(normalized.ModuleShape, []);
    assert.deepEqual(normalized.ModuleId, []);
  });
});

describe('runCoupling', () => {
  test('renders module-scope text output with SCC groups, ellipsis, and leaf clustering', () => {
    withFile(
      `
function leaf(): number { return 1; }
function middle(): number { return leaf(); }
function left(): number { return middle(); }
function right(): number { return middle(); }
function root(): number { return left() + right(); }
`,
      (filePath) => {
        const output = runCouplingWithOutput(filePath);
        assert.include(
          output,
          `Coupling analysis for ${filePath} (module scope)`,
        );
        assert.include(output, 'Dependents -> Dependencies:');
        assert.include(output, 'Dependencies -> Dependents:');
        assert.include(output, 'Leaf clustering (max cross-cluster distance):');
        assert.include(
          output,
          'Metric: minimum edge count between depth-0 groups, traversing edges in either direction.',
        );
        assert.include(output, 'Depth 0-1 subset weakly connected components:');
        assert.match(output, /^Group-3-\d+: root:$/m);
        assert.match(output, /^  Group-2-\d+: left:$/m);
        assert.match(output, /^  Group-2-\d+: right:$/m);
        assert.match(output, /^    Group-1-\d+: middle:$/m);
        assert.match(output, /^      Group-0-\d+: leaf\.$/m);
        assert.match(output, /^    Group-1-\d+: middle\.\.\.$/m);
        assert.match(output, /^Group-0-\d+: leaf:$/m);
        assert.match(output, /^  Group-1-\d+: middle:$/m);
        assert.match(output, /^    Group-2-\d+: left:$/m);
        assert.match(output, /^    Group-2-\d+: right:$/m);
        assert.match(output, /^      Group-3-\d+: root\.$/m);
        assert.match(output, /^Cross-cluster distance sum: 0$/m);
        assert.match(output, /^Cluster A: leaf$/m);
        assert.match(output, /^Cluster B: \(none\)$/m);
        assert.match(output, /^Component 1: leaf, middle$/m);
      },
    );
  });

  test('renders class-scope text output with SCC groups and cross-cluster metrics', () => {
    withFile(
      `
class ClassOutput {
  private left = 0;
  private right = 0;

  private first(): void {
    this.second();
    this.left = this.left + 1;
  }

  private second(): void {
    this.first();
    this.right = this.right + 1;
  }
}
`,
      (filePath) => {
        const output = runCouplingWithOutput(filePath, {
          class: 'ClassOutput',
        });
        assert.include(
          output,
          `Coupling analysis for ${filePath} (class scope (ClassOutput))`,
        );
        assert.include(output, 'Dependents -> Dependencies:');
        assert.include(output, 'Dependencies -> Dependents:');
        assert.include(output, 'Leaf clustering (max cross-cluster distance):');
        assert.include(
          output,
          'Metric: minimum edge count between depth-0 groups, traversing edges in either direction.',
        );
        assert.include(output, 'Depth 0-1 subset weakly connected components:');
        assert.match(output, /^Group-1-\d+: first, second:$/m);
        assert.match(output, /^  Group-0-\d+: left\.$/m);
        assert.match(output, /^  Group-0-\d+: right\.$/m);
        assert.match(output, /^Group-0-\d+: left:$/m);
        assert.match(output, /^  Group-1-\d+: first, second\.$/m);
        assert.match(output, /^Cross-cluster distance sum: 2$/m);
        assert.match(output, /^Cluster A: (left|right)$/m);
        assert.match(output, /^Cluster B: (left|right)$/m);
        assert.match(output, /^Component 1: first, second, left, right$/m);
      },
    );
  });

  test('renders Graphviz DOT output with depth-colored nodes', () => {
    withFile(
      `
const value = 1;
function alpha(): number { return beta() + value; }
function beta(): number { return alpha() + value; }
`,
      (filePath) => {
        const output = runCouplingWithOutput(filePath, { graphviz: true });
        assert.match(output, /^digraph Coupling \{/);
        assert.include(output, 'fillcolor="#');
        assert.match(output, /scc_\d+ -> scc_\d+;/);
        assert.include(output, 'Depth 0');
        assert.notMatch(output, /\\\\n/);
      },
    );
  });

  test('renders Graphviz depth-0/1 subset when requested', () => {
    withFile(
      `
function leaf(): number { return 1; }
function middleB(): number { return leaf(); }
function middleA(): number { return leaf() + middleB(); }
function root(): number { return middleA(); }
`,
      (filePath) => {
        const output = runCouplingWithOutput(filePath, {
          graphvizDepthZeroOneSubset: true,
        });
        assert.match(output, /^digraph Coupling \{/);
        const edgeLines = output.split('\n').filter((l) => l.includes('->'));
        assert.include(output, 'middleA');
        assert.include(output, 'middleB');
        assert.include(output, 'leaf');
        assert.notInclude(output, 'root');
        assert.lengthOf(edgeLines, 2);
      },
    );
  });

  test('handles disconnected dependency chains without crashing', () => {
    withFile(
      `
class DisconnectedChains {
  private leafA = 0;
  private leafB = 0;

  private middleA(): number { return this.leafA; }
  private middleB(): number { return this.leafB; }
  private root(): number { return this.middleA() + this.middleB(); }
}
`,
      (filePath) => {
        const output = runCouplingWithOutput(filePath, {
          class: 'DisconnectedChains',
        });
        assert.include(output, 'Leaf clustering');
        assert.include(output, 'Cluster A:');
        assert.include(output, 'Cluster B:');
        assert.include(output, 'Depth 0-1 subset weakly connected components:');
      },
    );
  });
});
