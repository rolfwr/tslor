import { assert, test } from 'vitest';
import { Project } from 'ts-morph';
import { parseIsolatedSourceCode } from './testUtils';
import { parseModule, analyzeImportUsageFromStaticInfo } from './staticAnalysis';
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
  const deps = buildIntraModuleDependencies(moduleInfo);
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

  const symbolDefinitions = extractSymbolDefinitions(sourceFile, allSymbols);
  const staticModuleInfo = parseModule(sourceFile);
  const importUsages = analyzeImportUsageFromStaticInfo(staticModuleInfo);
  const onlyUsedByTarget = findImportsOnlyUsedBySymbols(
    importUsages,
    allSymbols,
  );
  const requiredImports = computeRequiredImports(
    symbolDefinitions,
    importUsages,
  );

  const target = generateNewModuleSource(symbolDefinitions, requiredImports);

  let source = removeSymbolsFromSource(sourceInput, allSymbols);
  source = removeUnusedImports(source, onlyUsedByTarget);
  source = addImportForMovedSymbols(
    source,
    allSymbols,
    `./${targetFileName.replace('.ts', '')}`,
    true,
    symbolDefinitions,
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
