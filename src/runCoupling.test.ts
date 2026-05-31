import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert, describe, test } from 'vitest';
import { parseClassCoupling, parseModuleCoupling, runCoupling } from './runCoupling';
import type { CouplingGraph } from './runCoupling';

function withTemporarySourceFile(
  fileName: string,
  sourceCode: string,
  testBody: (filePath: string) => void
): void {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'tslor-coupling-'));
  const filePath = join(tempDirectory, fileName);

  try {
    writeFileSync(filePath, sourceCode);
    testBody(filePath);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function normalizeGraph(graph: CouplingGraph): Record<string, string[]> {
  const normalizedEntries = [...graph.entries()]
    .map(([memberName, dependencies]): [string, string[]] => [
      memberName,
      [...dependencies].sort(),
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));

  return Object.fromEntries(normalizedEntries);
}

describe('parseClassCoupling', () => {
  test('parses class members and captures this.X dependencies', () => {
    withTemporarySourceFile(
      'Example.ts',
      `
class Example {
  private count = 0;
  private label = 'ready';

  private readonly onTick = () => {
    this.count = this.compute();
    this.onTick();
    this.unknownField = 1;
  };

  constructor() {
    this.init();
    this.count = this.compute();
    this.unknownCtor();
  }

  private init(): void {
    this.onTick();
    this.count = this.count + 1;
  }

  private compute(): number {
    return this.count;
  }

  private untouched(): void {
    this.unknown;
    this.untouched();
  }
}
`,
      (filePath) => {
        const graph = parseClassCoupling(filePath, 'Example');

        assert.deepEqual(normalizeGraph(graph), {
          compute: ['count'],
          constructor: ['compute', 'count', 'init'],
          count: [],
          init: ['count', 'onTick'],
          label: [],
          onTick: ['compute', 'count'],
          untouched: [],
        });
      }
    );
  });

  test('captures this.X dependencies in class field initializers', () => {
    withTemporarySourceFile(
      'FieldInitializerDependencies.ts',
      `
class FieldInitializerDependencies {
  private base = 1;
  private doubled = this.base * 2;
  private tripled = this.doubled + this.base;
}
`,
      (filePath) => {
        const graph = parseClassCoupling(filePath, 'FieldInitializerDependencies');

        assert.deepEqual(normalizeGraph(graph), {
          base: [],
          doubled: ['base'],
          tripled: ['base', 'doubled'],
        });
      }
    );
  });

  test('captures this.X dependencies in concise arrow-function properties', () => {
    withTemporarySourceFile(
      'ConciseArrowBody.ts',
      `
class ConciseArrowBody {
  private value = 1;

  private readonly read = () => this.value;

  private readonly trigger = () => this.read();
}
`,
      (filePath) => {
        const graph = parseClassCoupling(filePath, 'ConciseArrowBody');

        assert.deepEqual(normalizeGraph(graph), {
          read: ['value'],
          trigger: ['read'],
          value: [],
        });
      }
    );
  });

  test('ignores this.X from nested non-arrow this scopes', () => {
    withTemporarySourceFile(
      'NestedScopes.ts',
      `
class NestedScopes {
  private count = 0;

  private wrapper(): void {
    const callback = function(this: { count: number }): void {
      this.count = this.count + 1;
    };

    class Local {
      private count = 0;

      private readonly update = () => {
        this.count = this.count + 1;
      };

      run(): void {
        this.count = this.count + 1;
        this.update();
      }
    }

    callback.call({ count: 1 });
    void Local;
  }
}
`,
      (filePath) => {
        const graph = parseClassCoupling(filePath, 'NestedScopes');

        assert.deepEqual(normalizeGraph(graph), {
          count: [],
          wrapper: [],
        });
      }
    );
  });
});

describe('parseModuleCoupling', () => {
  test('parses module declarations and captures bare-name dependencies', () => {
    withTemporarySourceFile(
      'ModuleExample.ts',
      `
import { externalThing } from './external';

const shared = 1;
const makeShared = () => shared;
const alias = function namedAlias() {
  return makeShared();
};
const derived = shared + 1;
const first = 1,
  second = () => makeShared();

interface ModuleShape {
  value: number;
}

type ModuleId = string;

class Worker {
  constructor() {
    void shared;
  }

  run(): number {
    return makeShared();
  }

  static create(): Worker {
    return new Worker();
  }
}

function orchestrate(): number {
  void externalThing;
  void missingName;
  return makeShared() + shared + Math.max(1, 2);
}

function recursive(): number {
  return recursive();
}
`,
      (filePath) => {
        const graph = parseModuleCoupling(filePath);

        assert.deepEqual(normalizeGraph(graph), {
          ModuleId: [],
          ModuleShape: [],
          Worker: ['makeShared', 'shared'],
          alias: ['makeShared'],
          derived: ['shared'],
          first: [],
          makeShared: ['shared'],
          orchestrate: ['makeShared', 'shared'],
          recursive: [],
          second: ['makeShared'],
          shared: [],
        });
      }
    );
  });

  test('captures dependencies from class property initializers and static blocks', () => {
    withTemporarySourceFile(
      'ModuleClassInitializers.ts',
      `
const shared = 1;
const makeShared = () => shared;
const helper = () => 0;

class Worker {
  private value = shared;
  private readonly read = () => makeShared();

  static {
    void shared;
    void helper();
  }
}
`,
      (filePath) => {
        const graph = parseModuleCoupling(filePath);

        assert.deepEqual(normalizeGraph(graph), {
          Worker: ['helper', 'makeShared', 'shared'],
          helper: [],
          makeShared: ['shared'],
          shared: [],
        });
      }
    );
  });

  test('tracks destructured top-level variable declarations as individual module members', () => {
    withTemporarySourceFile(
      'ModuleDestructuring.ts',
      `
const source = { alpha: 1, beta: 2 };
const { alpha, beta: renamedBeta } = source;

function readAlpha(): number {
  return alpha;
}

function readRenamedBeta(): number {
  return renamedBeta;
}
`,
      (filePath) => {
        const graph = parseModuleCoupling(filePath);

        assert.deepEqual(normalizeGraph(graph), {
          alpha: ['source'],
          readAlpha: ['alpha'],
          readRenamedBeta: ['renamedBeta'],
          renamedBeta: ['source'],
          source: [],
        });
      }
    );
  });
});

describe('runCoupling', () => {
  test('renders text output grouped by depth with SCC details in class scope', () => {
    withTemporarySourceFile(
      'ClassOutput.ts',
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
        const chunks: string[] = [];

        runCoupling(filePath, {
          class: 'ClassOutput',
          output: {
            write: (text) => {
              chunks.push(text);
            },
          },
        });

        const output = chunks.join('');
        assert.include(output, `Coupling analysis for ${filePath} (class scope (ClassOutput))`);
        assert.include(output, 'Depth 0:');
        assert.include(output, 'Depth 1:');
        assert.include(output, 'depth=0');
        assert.include(output, 'depth=1');
        assert.include(output, '2 members: first, second');
        assert.include(output, '1 member: left');
        assert.include(output, '1 member: right');
      }
    );
  });

  test('renders Graphviz DOT output with depth-colored nodes in module scope', () => {
    withTemporarySourceFile(
      'ModuleOutput.ts',
      `
const value = 1;

function alpha(): number {
  return beta() + value;
}

function beta(): number {
  return alpha() + value;
}
`,
      (filePath) => {
        const chunks: string[] = [];

        runCoupling(filePath, {
          graphviz: true,
          output: {
            write: (text) => {
              chunks.push(text);
            },
          },
        });

        const output = chunks.join('');
        assert.match(output, /^digraph Coupling \{/);
        assert.include(output, 'fillcolor="#');
        assert.match(output, /scc_\d+ -> scc_\d+;/);
        assert.include(output, 'Depth 0');
      }
    );
  });
});
