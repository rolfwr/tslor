import { assert, describe, test } from 'vitest';
import { Project } from 'ts-morph';
import { parseIsolatedSourceCode } from './testUtils';
import { analyzeImportUsageFromStaticInfo } from './staticAnalysis';
import {
  buildIntraModuleDependencies,
  analyzeSplit,
  extractSymbolDefinitions,
  findImportsOnlyUsedBySymbols,
  computeRequiredImports,
  generateNewModuleSource,
  removeSymbolsFromSource,
  removeUnusedImports,
  addImportForMovedSymbols,
  findSharedNonExportedDeps,
  validateSymbolsHaveDeclarations,
} from './splitModule';

function runSplit(
  project: Project,
  sourceInput: string,
  symbolsToMove: string[],
  extraFiles: { name: string; content: string }[],
): { source: string; target: string } {
  for (const { name, content } of extraFiles) {
    project.createSourceFile(name, content);
  }

  const sourceFile = project.createSourceFile('source.ts', sourceInput);
  const targetFileName = 'target.ts';

  const moduleInfo = parseIsolatedSourceCode(sourceInput);
  const deps = buildIntraModuleDependencies(moduleInfo, sourceInput);
  const allSymbols = new Set(symbolsToMove);

  for (const symbol of symbolsToMove) {
    const analysis = analyzeSplit(deps, symbol);
    if (!analysis.canSplit) {
      throw new Error(
        `Cannot split ${symbol}: ${analysis.circularDependencies.join(', ')}`,
      );
    }
    for (const dep of analysis.requiredDependencies) {
      allSymbols.add(dep);
    }
  }

  const exportedSymbolsToMove = new Set(
    [...allSymbols].filter((s) => deps.exports.has(s)),
  );
  if (
    exportedSymbolsToMove.size === deps.exports.size &&
    deps.exports.size > 0
  ) {
    throw new Error('Cannot move all exported symbols');
  }

  // Invariant: every symbol scheduled for extraction must have an actual
  // declaration in the source file.
  validateSymbolsHaveDeclarations(sourceFile, allSymbols, 'source.ts');

  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbols);
  const importUsages = analyzeImportUsageFromStaticInfo(moduleInfo);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
    importUsages,
    allSymbols,
  );
  const requiredImports = computeRequiredImports(
    symbolDefinitions,
    importUsages,
    {},
  );

  const sharedNonExportedDeps = findSharedNonExportedDeps(deps, allSymbols);
  const target = generateNewModuleSource(
    symbolDefinitions,
    requiredImports,
    { additionalExports: sharedNonExportedDeps },
  );

  let source = removeSymbolsFromSource(sourceInput, allSymbols);
  source = removeUnusedImports(source, onlyUsedByTarget);

  // Re-export the originally-exported symbols in the source module.
  const modulePath = `./${targetFileName.replace('.ts', '')}`;
  source = addImportForMovedSymbols(
    source,
    exportedSymbolsToMove,
    modulePath,
    true,
    { symbolDefinitions },
  );

  // Import shared non-exported deps (used by staying symbols) from target.
  source = addImportForMovedSymbols(
    source,
    sharedNonExportedDeps,
    modulePath,
    false,
    { symbolDefinitions },
  );

  project.createSourceFile(targetFileName, target);
  sourceFile.replaceWithText(source);

  const diagnostics = project.getPreEmitDiagnostics();
  assert.equal(
    diagnostics.length,
    0,
    diagnostics
      .map((d) => {
        const msg = d.getMessageText();
        return typeof msg === 'string' ? msg : msg.getMessageText();
      })
      .join('; '),
  );

  return { source, target };
}

test('preserves type-only default imports', () => {
  const project = new Project({ useInMemoryFileSystem: true });

  const result = runSplit(
    project,
    `import type ExternalType from './external';

export interface MyInterface {
    field: ExternalType;
}

export const helperFunc = () => 'helper';
`,
    ['MyInterface'],
    [
      {
        name: 'external.ts',
        content: 'export default interface ExternalType { prop: string; }',
      },
    ],
  );

  assert.include(result.target, 'import type ExternalType from');
  assert.include(result.target, 'from "./external"');
  assert.include(result.target, 'export interface MyInterface');
  assert.include(result.target, 'field: ExternalType');
  assert.include(result.source, 'export type { MyInterface } from "./target"');
  assert.include(result.source, 'export const helperFunc');
  assert.notInclude(result.source, 'interface MyInterface {');
  assert.notInclude(result.source, 'ExternalType');
});

test('regular default import preserved in split', () => {
  const project = new Project({ useInMemoryFileSystem: true });

  const result = runSplit(
    project,
    `import ExternalValue from './external';

export const myConst = ExternalValue;

export const helperFunc = () => 'helper';
`,
    ['myConst'],
    [
      {
        name: 'external.ts',
        content: 'const value = 42; export default value;',
      },
    ],
  );

  assert.include(result.target, 'import ExternalValue from');
  assert.notInclude(result.target, 'import type ExternalValue');
});

test('type property dependencies: consumer code remains compatible after split', () => {
  const project = new Project({ useInMemoryFileSystem: true });

  const itemSource = `
export interface DerivedClip {
  type: "derived";
}

export interface VirtualClip extends DerivedClip {
  masterClipId: string;
  inPoint: number;
  outPoint: number;
}

export interface Item {
  id: string;
  virtualClipInfo?: VirtualClip;
}

export interface PendingArchiveRequest {
  itemId: string;
}

export interface PendingTransferRequest {
  itemId: string;
}

export interface OtherType {
  value: string;
}
`;

  const consumerSource = `
import { Item, VirtualClip } from './source';

export function getVirtualClip(item: Item): VirtualClip | undefined {
  return item.virtualClipInfo;
}

export function createItem(): Item {
  return {
    id: "test",
    virtualClipInfo: {
      type: "derived",
      masterClipId: "master123",
      inPoint: 0,
      outPoint: 100
    }
  };
}
`;

  runSplit(
    project,
    itemSource,
    ['Item', 'PendingArchiveRequest', 'PendingTransferRequest'],
    [{ name: 'consumer.ts', content: consumerSource }],
  );
});

test('non-existent symbols should be rejected', () => {
  const project = new Project({ useInMemoryFileSystem: true });

  assert.throws(
    () =>
      runSplit(
        project,
        `
export function hello(): string {
  return 'world';
}

export function goodbye(): string {
  return 'farewell';
}
`,
        ['nonExistentFunction'],
        [],
      ),
    /nonExistentFunction.*not exported/,
  );
});

test('moving all symbols should be rejected', () => {
  const project = new Project({ useInMemoryFileSystem: true });

  assert.throws(
    () =>
      runSplit(
        project,
        `
export function hello(): string {
  return 'world';
}

export function goodbye(): string {
  return 'farewell';
}
`,
        ['hello', 'goodbye'],
        [],
      ),
    /Cannot move all exported symbols/,
  );
});

describe('enum declarations', () => {
  test('extracted enum appears in target module and is removed from source', () => {
    const project = new Project({ useInMemoryFileSystem: true });

    const result = runSplit(
      project,
      `
export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}

export function getStatusLabel(s: Status): string {
  return Status[s];
}

export function otherUtil(): string {
  return 'other';
}
`,
      ['Status'],
      [],
    );

    assert.include(
      result.target,
      'export enum Status',
      'Target module should contain the enum declaration',
    );
    assert.include(result.target, "Active = 'active'");
    assert.include(result.target, "Inactive = 'inactive'");

    assert.notInclude(
      result.source,
      'enum Status',
      'Source module should not contain the enum declaration',
    );

    assert.match(
      result.source,
      /export\s*{\s*Status\s*}\s*from/,
      'Source should re-export Status from the target module',
    );

    assert.include(result.source, 'export function otherUtil');
  });

  test('non-exported enum used by moved function travels with it', () => {
    /*
      A private enum that is only used by a moved function must travel
      with it. The target module contains both the function and the enum.
      The source removes the enum and re-exports the function.
    */
    const project = new Project({ useInMemoryFileSystem: true });

    const result = runSplit(
      project,
      `
enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}

export function formatPriority(p: Priority): string {
  return 'Priority: ' + Priority[p];
}

export function standalone(): string {
  return 'ok';
}
`,
      ['formatPriority'],
      [],
    );

    assert.include(
      result.target,
      'enum Priority',
      'Target module should contain the enum declaration',
    );
    assert.include(result.target, 'export function formatPriority');

    assert.notInclude(
      result.source,
      'enum Priority',
      'Source should not contain the enum after removal',
    );

    assert.match(
      result.source,
      /export\s*{\s*formatPriority\s*}\s*from/,
      'Source should re-export formatPriority',
    );

    assert.include(result.source, 'export function standalone');
  });

  test('non-exported enum shared between moved and staying symbols is exported from target', () => {
    /*
      When a staying function also references the enum, it becomes a
      shared non-exported dependency. The target exports it and the
      source imports it.
    */
    const project = new Project({ useInMemoryFileSystem: true });

    const result = runSplit(
      project,
      `
enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}

export function formatPriority(p: Priority): string {
  return 'Priority: ' + Priority[p];
}

export function getPriorityLevel(p: Priority): string {
  return p === Priority.High ? 'critical' : 'normal';
}

export function standalone(): string {
  return 'ok';
}
`,
      ['formatPriority'],
      [],
    );

    assert.include(
      result.target,
      'export enum Priority',
      'Target module should export the shared enum',
    );
    assert.include(result.target, 'export function formatPriority');

    assert.match(
      result.source,
      /import.*Priority.*from.*target/,
      'Source should import Priority from target',
    );

    // Source does NOT re-export Priority (it was not originally exported)
    assert.notMatch(
      result.source,
      /^export\s*{[^}\n]*\bPriority\b[^}\n]*}\s*from/m,
      'Source should not re-export Priority',
    );

    assert.include(result.source, 'export function getPriorityLevel');
  });

  test('enum referenced in type position is classified as a value import', () => {
    /*
      Enums are value-level declarations. Even when referenced only in
      type annotations (e.g. `x: Status`), the import must be a value
      import, not a type import.
    */
    const project = new Project({ useInMemoryFileSystem: true });

    const result = runSplit(
      project,
      `
export enum Status {
  Active = 1,
  Inactive = 0,
}

export function isActive(s: Status): boolean {
  return s === Status.Active;
}

export function other(): void {}
`,
      ['Status'],
      [],
    );

    assert.match(
      result.source,
      /export\s*{\s*Status\s*}\s*from/,
      'Should re-export Status as a value',
    );
    assert.notMatch(
      result.source,
      /export\s+type\s+{[^}]*Status[^}]*}/,
      'Status must NOT be a type-only re-export',
    );
  });
});

test('does not add spurious import for loop variable shadowing moved type', () => {
  /*
    Regression test: when a moved type (e.g., ReExport) has a similar name
    to a loop variable (e.g., reExport) in remaining code, the tool should
    not add a spurious value import for the loop variable.
  */
  const project = new Project({ useInMemoryFileSystem: true });

  const result = runSplit(
    project,
    `
export interface ReExport {
  moduleSpec: string;
  names: string[];
}

export function processReExports(reExports: ReExport[]): string {
  let count = 0;
  for (const reExport of reExports) {
    count += reExport.names.length;
  }
  return String(count);
}

export function standalone(): string {
  return 'ok';
}
`,
    ['processReExports'],
    [],
  );

  assert.include(
    result.target,
    'export interface ReExport',
    'ReExport should move with processReExports',
  );
  assert.notMatch(
    result.source,
    /import\s*{\s*reExport\s*}/,
    'Must not import loop variable as a value',
  );
  assert.match(
    result.source,
    /export.*ReExport.*from.*target/,
    'ReExport type should be re-exported',
  );
});

describe('ambient declarations do not enter dependency graph', () => {
  test('ambient fetch does not enter the dependency graph, split succeeds', () => {
    /*
      `fetch` is not in the module-binding set, so it is ambient.
      The split succeeds — `fetch` is left untouched in both
      source and target modules, with no spurious import generated.
    */
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceCode = `
function helper(): string {
  return fetch('/api').toString();
}

export function moved(): string {
  return fetch('/api').toString();
}

export function staying(): string {
  return helper();
}
`;

    const result = runSplit(project, sourceCode, ['moved'], []);

    assert.include(result.target, 'export function moved');
    assert.include(result.source, 'function helper');
    assert.include(result.source, 'export function staying');
    assert.notMatch(result.source, /import.*fetch.*from.*target/);
    assert.match(result.source, /export.*moved.*from.*target/);
  });

  test('ambient process does not enter the dependency graph, split succeeds', () => {
    /*
      `process` is not in the module-binding set, so it is ambient.
      Because `process` is undefined in the in-memory project (no
      @types/node), we validate the dependency graph directly rather
      than through runSplit.
    */
    const sourceCode = `
function helper(): string {
  return process.env.NODE_ENV || 'dev';
}

export function moved(): string {
  return process.env.API_URL || 'http://localhost';
}

export function staying(): string {
  return helper();
}
`;

    const moduleInfo = parseIsolatedSourceCode(sourceCode);
    const deps = buildIntraModuleDependencies(moduleInfo, sourceCode);

    assert.isTrue(deps.definitions.has('helper'));
    assert.isFalse(deps.definitions.has('process'));

    const analysis = analyzeSplit(deps, 'moved');
    assert.equal(analysis.requiredDependencies.size, 0);
    assert.isTrue(analysis.canSplit);
  });
});
