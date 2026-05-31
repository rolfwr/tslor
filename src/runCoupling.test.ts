import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert, describe, test } from 'vitest';
import { parseClassCoupling } from './runCoupling';
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
