import { assert, test } from 'vitest';
import { assertDefined } from './invariant';
import { Project } from 'ts-morph';
import {
  runProposeImportDirectly,
  applyImportChangesToFile,
} from './runProposeImportDirectly';
import { DebugOptions } from './objstore';
import { ModifyFileChange } from './plan';
import { InMemoryRepositoryRootProvider } from './repositoryRootProvider';
import { InMemoryFileSystem } from './filesystem';

/**
 * Test that runProposeImportDirectly generates proper undo information
 */
test('runProposeImportDirectly generates undo information for rollback', async () => {
  const originalContent = `
export const itemCustomIconSlots = ['pos1', 'pos2', 'pos3'] as const;
export type ItemCustomIconSlot = typeof itemCustomIconSlots[number];
export type ItemCustomIconsDto = Partial<Record<ItemCustomIconSlot, ItemCustomIconDto | null>>;
export interface ItemCustomIconDto {
  icon: string;
  tooltip?: string;
}
export interface ItemCustomIconBlendedDto {
  iconIdentifier: string;
  iconUrl: string;
  tooltip?: string;
}
`;

  const reexportContent = `
// Re-export types from the original module
export type { ItemCustomIconsDto, ItemCustomIconDto, ItemCustomIconBlendedDto } from './original';
export { itemCustomIconSlots } from './original';
`;

  const consumerContent = `
import type { ItemCustomIconsDto } from './reexport';
import { type ItemCustomIconDto, itemCustomIconSlots } from './reexport';

export function useCustomIcons(): ItemCustomIconsDto {
  return itemCustomIconSlots.reduce((acc, slot) => {
    acc[slot] = { icon: 'test' };
    return acc;
  }, {} as ItemCustomIconsDto);
}
`;

  const tsconfigContent = `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}`;

  const files = new Map<string, string>([
    ['/repo/tsconfig.json', tsconfigContent],
    ['/repo/original.ts', originalContent],
    ['/repo/reexport.ts', reexportContent],
    ['/repo/consumer.ts', consumerContent],
  ]);

  const fileSystem = new InMemoryFileSystem(files);
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/original.ts',
    '/repo/reexport.ts',
    '/repo/consumer.ts',
  ]);

  const debugOptions: DebugOptions = { traceId: null };
  const plan = await runProposeImportDirectly(
    '/repo',
    debugOptions,
    false,
    repoProvider,
    fileSystem,
    () => {},
    '/repo',
  );

  // The plan should have changes (imports to modify)
  assert(plan.changes.length > 0, 'Plan should have changes');

  // The plan should have undo information
  assert(
    plan.undo && plan.undo.length > 0,
    'Plan should have undo information for rollback',
  );

  /*
    Verify that undo changes would restore the original imports.
    Each change should have a corresponding undo that reverses it.
  */
  assert.equal(
    plan.changes.length,
    plan.undo.length,
    'Should have same number of changes and undo operations',
  );

  // Check that undo operations are the reverse of changes
  for (let i = 0; i < plan.changes.length; i++) {
    const change = plan.changes.at(i);
    const undo = plan.undo.at(i);
    if (change === undefined || undo === undefined) {
      continue;
    }

    assert.equal(
      change.type,
      undo.type,
      `Change and undo types should match for index ${i}`,
    );

    if (change.type === 'modify-file' && undo.type === 'modify-file') {
      /*
        The undo content should restore the original file content.
        For import changes, this means changing back from './original' to './reexport'.
      */
      assert(
        undo.content.includes("from './reexport'"),
        `Undo should restore import from reexport, got: ${undo.content}`,
      );
      assert(
        !undo.content.includes("from './original'"),
        `Undo should not contain import from original, got: ${undo.content}`,
      );
    }
  }
});

/**
 * Test that propose-import-directly does not change imports when the target symbol
 * does not actually exist in the original module. `fakeFunction` is defined locally
 * in vueCompat (not re-exported from realModule), so it must not be redirected.
 * `realFunction` is a genuine re-export and should be redirected to realModule.
 */
test('propose-import-directly does not change imports for non-existent symbols', async () => {
  const files = new Map<string, string>([
    [
      '/repo/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'Bundler',
        },
        include: ['*.ts'],
      }),
    ],
    ['/repo/realModule.ts', "export const realFunction = () => 'real';"],
    [
      '/repo/vueCompat.ts',
      [
        "export { realFunction } from './realModule';",
        "export const fakeFunction = () => 'fake';",
      ].join('\n'),
    ],
    [
      '/repo/consumer.ts',
      "import { realFunction, fakeFunction } from './vueCompat';",
    ],
  ]);

  const fileSystem = new InMemoryFileSystem(files);
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/realModule.ts',
    '/repo/vueCompat.ts',
    '/repo/consumer.ts',
  ]);
  const debugOptions: DebugOptions = { traceId: null };

  const plan = await runProposeImportDirectly(
    '/repo',
    debugOptions,
    false,
    repoProvider,
    fileSystem,
    () => {},
    '/repo',
  );

  /*
    realFunction is re-exported from realModule via vueCompat — it should be
    redirected. fakeFunction is defined locally in vueCompat (not re-exported)
    and does not exist in realModule — it must stay.
  */
  const consumerChange = plan.changes.find(
    (c): c is ModifyFileChange =>
      c.type === 'modify-file' && c.path === '/repo/consumer.ts',
  );

  if (consumerChange === undefined) {
    assert.fail('consumer.ts should be modified to redirect realFunction');
  }

  const content = consumerChange.content;

  // realFunction should be redirected to realModule
  assert.match(
    content,
    /realFunction.*from.*\.\/realModule/,
    'realFunction must be redirected to realModule',
  );

  // fakeFunction must remain imported from vueCompat
  assert.match(
    content,
    /fakeFunction.*from.*\.\/vueCompat/,
    'fakeFunction must remain imported from vueCompat (not in realModule)',
  );
});

test('applyImportChangesToFile splits mixed imports when only some symbols are re-exports', () => {
  /*
    Reproduction from _bug_import_directly_empty_changes.md:
    An import mixes a non-re-exported symbol (getItemRequestSchema) with a re-exported
    symbol (getItemResponseSchema). The tool detects the re-export but skips the change
    because it can't rewrite ALL symbols in the import. It should split the import instead.
  */

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'consumer.ts',
    `
import type { getItemRequestSchema, getItemResponseSchema } from '../../api/schemas/item/getItem';
`,
  );

  // Only getItemResponseSchema should be redirected
  const changes = [
    {
      symbolName: 'getItemResponseSchema',
      currentModuleSpec: '../../api/schemas/item/getItem',
      newModuleSpec: '../../api/schemas/item/getItemResponse',
      isTypeOnly: true,
    },
  ];

  applyImportChangesToFile(sourceFile, changes, 'consumer.ts');

  const result = sourceFile.getFullText();

  // The original import should be narrowed to only the unchanged symbol
  assert.match(
    result,
    /getItemRequestSchema/,
    'getItemRequestSchema must remain imported from the original module',
  );
  assert.match(
    result,
    /from ['"]\.\.\/\.\.\/api\/schemas\/item\/getItem['"]/,
    'getItemRequestSchema must still point at getItem',
  );

  // A new import should be added for the redirected symbol
  assert.match(
    result,
    /getItemResponseSchema/,
    'getItemResponseSchema must be imported from the new module',
  );
  assert.match(
    result,
    /from ['"]\.\.\/\.\.\/api\/schemas\/item\/getItemResponse['"]/,
    'getItemResponseSchema must point at getItemResponse',
  );

  // The redirected symbol must NOT remain in the original import
  const importDecls = sourceFile.getImportDeclarations();
  const originalImport = importDecls.find(
    (d) => d.getModuleSpecifierValue() === '../../api/schemas/item/getItem',
  );
  assertDefined(
    originalImport,
    'Original import declaration should still exist',
  );
  const originalNames = originalImport
    .getNamedImports()
    .map((n) => n.getName());
  assert.notInclude(
    originalNames,
    'getItemResponseSchema',
    'getItemResponseSchema must be removed from the original import',
  );
});

test('applyImportChangesToFile splits mixed import with multiple re-exported symbols', () => {
  /*
    Updated scenario from _bug_import_directly_empty_changes.md:
    Import has one non-re-exported symbol (getItemRequestSchema) and two re-exported
    symbols (getItemResponseSchema, GetItemResponse) going to the same target module.
  */

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'consumer.ts',
    `
import type { getItemRequestSchema, getItemResponseSchema, GetItemResponse } from '../../api/schemas/item/getItem';
`,
  );

  const changes = [
    {
      symbolName: 'getItemResponseSchema',
      currentModuleSpec: '../../api/schemas/item/getItem',
      newModuleSpec: '../../api/schemas/item/getItemResponse',
      isTypeOnly: true,
    },
    {
      symbolName: 'GetItemResponse',
      currentModuleSpec: '../../api/schemas/item/getItem',
      newModuleSpec: '../../api/schemas/item/getItemResponse',
      isTypeOnly: true,
    },
  ];

  applyImportChangesToFile(sourceFile, changes, 'consumer.ts');

  // Original import keeps only the non-re-exported symbol
  const importDecls = sourceFile.getImportDeclarations();
  const originalImport = importDecls.find(
    (d) => d.getModuleSpecifierValue() === '../../api/schemas/item/getItem',
  );
  assertDefined(originalImport, 'Original import should still exist');
  const originalNames = originalImport
    .getNamedImports()
    .map((n) => n.getName());
  assert.deepEqual(
    originalNames,
    ['getItemRequestSchema'],
    'Only getItemRequestSchema should remain in the original import',
  );

  // New import has both re-exported symbols pointing at the target module
  const newImport = importDecls.find(
    (d) =>
      d.getModuleSpecifierValue() === '../../api/schemas/item/getItemResponse',
  );
  assertDefined(
    newImport,
    'New import pointing at getItemResponse should exist',
  );
  const newNames = newImport
    .getNamedImports()
    .map((n) => n.getName())
    .sort();
  assert.deepEqual(
    newNames,
    ['GetItemResponse', 'getItemResponseSchema'],
    'Both re-exported symbols should be in the new import',
  );

  // New import should be type-only since all moved symbols are type-only
  assert.isTrue(newImport.isTypeOnly(), 'New import should be type-only');
});

test('applyImportChangesToFile preserves per-symbol type qualifier when splitting', () => {
  /*
    Reproduction from _bug_import_directly_drops_type.md:
    `import { startS3Server, type BucketConfiguration } from '...'` is split,
    but the new import for BucketConfiguration loses the `type` qualifier.
  */

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'consumer.ts',
    `
import { startS3Server, type BucketConfiguration } from '@mimir/s3-server/s3server';
`,
  );

  const changes = [
    {
      symbolName: 'BucketConfiguration',
      currentModuleSpec: '@mimir/s3-server/s3server',
      newModuleSpec: '@mimir/s3-server/bucketConfiguration',
      isTypeOnly: true,
    },
  ];

  applyImportChangesToFile(sourceFile, changes, 'consumer.ts');

  const result = sourceFile.getFullText();

  // The new import must be type-only
  assert.match(
    result,
    /import\s+type\s*\{[^}]*BucketConfiguration[^}]*\}\s*from\s*['"]@mimir\/s3-server\/bucketConfiguration['"]/,
    'New import for BucketConfiguration must have the type qualifier',
  );

  // startS3Server must remain as a value import from the original module
  assert.match(result, /startS3Server/, 'startS3Server must remain imported');
  assert.match(
    result,
    /from ['"]@mimir\/s3-server\/s3server['"]/,
    'startS3Server must still point at s3server',
  );
});

test('runProposeImportDirectly produces changes for mixed imports (relative paths)', async () => {
  /*
    Reproduction of _bug_import_directly_empty_changes.md (relative-path variant):
    A consumer import mixes a locally-defined symbol with a re-exported symbol.
    The pipeline should detect the re-exported symbol AND produce a file change
    that splits the import.
  */

  const files = new Map<string, string>([
    [
      '/repo/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'Bundler',
        },
        include: ['*.ts'],
      }),
    ],
    [
      '/repo/getItemResponse.ts',
      [
        'export const getItemResponseSchema = "response";',
        'export type GetItemResponse = { id: string };',
      ].join('\n'),
    ],
    [
      '/repo/getItem.ts',
      [
        'export const getItemRequestSchema = "request";',
        'export { getItemResponseSchema, type GetItemResponse } from "./getItemResponse";',
      ].join('\n'),
    ],
    [
      '/repo/consumer.ts',
      [
        'import type { getItemRequestSchema, getItemResponseSchema } from "./getItem";',
      ].join('\n'),
    ],
  ]);

  const fileSystem = new InMemoryFileSystem(files);
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/getItemResponse.ts',
    '/repo/getItem.ts',
    '/repo/consumer.ts',
  ]);
  const debugOptions: DebugOptions = { traceId: null };

  const plan = await runProposeImportDirectly(
    '/repo',
    debugOptions,
    false,
    repoProvider,
    fileSystem,
    () => {},
    '/repo',
  );

  // The plan MUST have a change for consumer.ts
  assert.isAbove(
    plan.changes.length,
    0,
    'Plan should have at least one change',
  );
  const consumerChange = plan.changes.find(
    (c): c is ModifyFileChange =>
      c.type === 'modify-file' && c.path === '/repo/consumer.ts',
  );
  if (consumerChange === undefined) {
    assert.fail('consumer.ts should be modified to split the mixed import');
  }

  const content = consumerChange.content;
  assert.match(
    content,
    /getItemRequestSchema.*from.*\.\/getItem/,
    'getItemRequestSchema must remain imported from getItem',
  );
  assert.match(
    content,
    /getItemResponseSchema.*from.*\.\/getItemResponse/,
    'getItemResponseSchema must be redirected to getItemResponse',
  );
});

test('runProposeImportDirectly produces changes when consumer uses path-mapped imports', async () => {
  /*
    Reproduction of _bug_import_directly_empty_changes.md (path-alias variant):
    The consumer uses a tsconfig paths alias (e.g. @repo/...) instead of a
    relative path. resolveImportSpecAlias returns the alias form, but the
    actual import declaration in the source uses a relative path. The module
    spec mismatch causes applyImportChangesToFile to silently skip the change.
  */

  const files = new Map<string, string>([
    [
      '/repo/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'Bundler',
          paths: { '@repo/*': ['src/*'] },
          baseUrl: '.',
        },
        include: ['src/**/*.ts'],
      }),
    ],
    [
      '/repo/src/getItemResponse.ts',
      [
        'export const getItemResponseSchema = "response";',
        'export type GetItemResponse = { id: string };',
      ].join('\n'),
    ],
    [
      '/repo/src/getItem.ts',
      [
        'export const getItemRequestSchema = "request";',
        'export { getItemResponseSchema, type GetItemResponse } from "./getItemResponse";',
      ].join('\n'),
    ],
    [
      '/repo/src/consumer.ts',
      [
        'import type { getItemRequestSchema, getItemResponseSchema } from "./getItem";',
      ].join('\n'),
    ],
  ]);

  const fileSystem = new InMemoryFileSystem(files);
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/src/getItemResponse.ts',
    '/repo/src/getItem.ts',
    '/repo/src/consumer.ts',
  ]);
  const debugOptions: DebugOptions = { traceId: null };

  const plan = await runProposeImportDirectly(
    '/repo/src',
    debugOptions,
    false,
    repoProvider,
    fileSystem,
    () => {},
    '/repo/src',
  );

  assert.isAbove(
    plan.changes.length,
    0,
    'Plan should have at least one change',
  );
  const consumerChange = plan.changes.find(
    (c): c is ModifyFileChange =>
      c.type === 'modify-file' && c.path === '/repo/src/consumer.ts',
  );
  if (consumerChange === undefined) {
    assert.fail(
      'consumer.ts should be modified even when tsconfig has path aliases',
    );
  }

  const content = consumerChange.content;
  assert.match(
    content,
    /getItemRequestSchema.*from.*\.\/getItem/,
    'getItemRequestSchema must remain imported from getItem',
  );
  assert.match(
    content,
    /getItemResponseSchema.*from.*\.\/getItemResponse/,
    'getItemResponseSchema must be redirected to getItemResponse',
  );
});

test('runProposeImportDirectly handles bare package re-exports', async () => {
  /*
    Reproduction of the bare-package bug:
    A barrel file re-exports symbols from a bare npm package (e.g., 'some-lib').
    Consumers import from the barrel. The command should redirect consumers
    to import directly from the bare package, not silently drop the change.
  */

  const files = new Map<string, string>([
    [
      '/repo/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'Bundler',
        },
        include: ['*.ts'],
      }),
    ],
    [
      '/repo/barrel.ts',
      ['export { computed, ref, reactive } from "some-lib";'].join('\n'),
    ],
    [
      '/repo/consumer.ts',
      ['import { computed, ref } from "./barrel";'].join('\n'),
    ],
  ]);

  const fileSystem = new InMemoryFileSystem(files);
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/barrel.ts',
    '/repo/consumer.ts',
  ]);
  const debugOptions: DebugOptions = { traceId: null };

  const plan = await runProposeImportDirectly(
    '/repo',
    debugOptions,
    false,
    repoProvider,
    fileSystem,
    () => {},
    '/repo',
  );

  /*
    The plan MUST have changes — consumer.ts should import from 'some-lib'
    directly instead of from './barrel'.
  */
  assert.isAbove(
    plan.changes.length,
    0,
    'Plan should have changes for bare package re-exports',
  );

  const consumerChange = plan.changes.find(
    (c): c is ModifyFileChange =>
      c.type === 'modify-file' && c.path === '/repo/consumer.ts',
  );
  if (consumerChange === undefined) {
    assert.fail('consumer.ts should be modified to import from bare package');
  }

  const content = consumerChange.content;
  assert.match(
    content,
    /from ['"]some-lib['"]/,
    'consumer should import from the bare package "some-lib"',
  );
  assert.match(content, /computed/, 'computed should still be imported');
  assert.match(content, /ref/, 'ref should still be imported');
  assert.notMatch(
    content,
    /from ['"]\.\/barrel['"]/,
    'consumer should NOT import from barrel anymore',
  );
});

test('applyImportChangesToFile splits import when symbols redirect to different modules', () => {
  /*
    Bug: when all symbols in an import are redirected, processImportDecl
    used specChanges[0].newModuleSpec for all of them, assuming they
    share a single target. This caused 'loadSourceFile' (which should
    go to ./loadSourceFile) to be incorrectly redirected to ./staticAnalysis.
  */
  const project = new Project({ useInMemoryFileSystem: true });
  const source = `import { parseModule, loadSourceFile, StaticModuleInfo } from './indexing';
import type { FileSystem } from './filesystem';
`;

  const sf = project.createSourceFile('test.ts', source);

  const changes = [
    {
      symbolName: 'parseModule',
      currentModuleSpec: './indexing',
      newModuleSpec: './staticAnalysis',
      isTypeOnly: false,
    },
    {
      symbolName: 'loadSourceFile',
      currentModuleSpec: './indexing',
      newModuleSpec: './loadSourceFile',
      isTypeOnly: false,
    },
    {
      symbolName: 'StaticModuleInfo',
      currentModuleSpec: './indexing',
      newModuleSpec: './staticAnalysis',
      isTypeOnly: false,
    },
  ];

  applyImportChangesToFile(sf, changes, 'test.ts');

  const imports = sf.getImportDeclarations();

  assert.equal(
    imports.length,
    3,
    'Should have 3 imports: staticAnalysis, loadSourceFile, filesystem',
  );

  const staticAnalysisImport = imports.find(
    (i) => i.getModuleSpecifierValue() === './staticAnalysis',
  );
  assertDefined(staticAnalysisImport, 'staticAnalysis import missing');
  const staticAnalysisSymbols = staticAnalysisImport
    .getNamedImports()
    .map((ni) => ni.getName());
  assert.include(staticAnalysisSymbols, 'parseModule');
  assert.include(staticAnalysisSymbols, 'StaticModuleInfo');
  assert.notInclude(staticAnalysisSymbols, 'loadSourceFile');

  const loadSourceFileImport = imports.find(
    (i) => i.getModuleSpecifierValue() === './loadSourceFile',
  );
  assertDefined(loadSourceFileImport, 'loadSourceFile import missing');
  const loadSourceFileSymbols = loadSourceFileImport
    .getNamedImports()
    .map((ni) => ni.getName());
  assert.deepEqual(loadSourceFileSymbols, ['loadSourceFile']);
});

test('runProposeImportDirectly handles mixed imports with re-exports to different modules', async () => {
  /*
    Full-pipeline test for the mixed-import case where some symbols are
    locally-defined in the barrel and re-exported symbols go to DIFFERENT
    target modules. This mirrors the real-world case:

      import { loadSourceFile, NODEJS_GLOBALS } from './indexing';

    where indexing.ts re-exports loadSourceFile from ./loadSourceFile and
    NODEJS_GLOBALS from ./staticAnalysis, plus defines local symbols.
  */

  const files = new Map<string, string>([
    [
      '/repo/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'Bundler',
        },
        include: ['*.ts'],
      }),
    ],
    ['/repo/moduleA.ts', "export const symbolA = 'a';"],
    ['/repo/moduleB.ts', "export const symbolB = 'b';"],
    [
      '/repo/barrel.ts',
      [
        "export const localSymbol = 'local';",
        "export { symbolA } from './moduleA';",
        "export { symbolB } from './moduleB';",
      ].join('\n'),
    ],
    ['/repo/consumer.ts', 'import { localSymbol, symbolA, symbolB } from "./barrel";'],
  ]);

  const fileSystem = new InMemoryFileSystem(files);
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/moduleA.ts',
    '/repo/moduleB.ts',
    '/repo/barrel.ts',
    '/repo/consumer.ts',
  ]);
  const debugOptions: DebugOptions = { traceId: null };

  const plan = await runProposeImportDirectly(
    '/repo',
    debugOptions,
    false,
    repoProvider,
    fileSystem,
    () => {},
    '/repo',
  );

  assert.isAbove(
    plan.changes.length,
    0,
    'Plan should have at least one change',
  );
  const consumerChange = plan.changes.find(
    (c): c is ModifyFileChange =>
      c.type === 'modify-file' && c.path === '/repo/consumer.ts',
  );
  if (consumerChange === undefined) {
    assert.fail(
      'consumer.ts should be modified to split the mixed import across different modules',
    );
  }

  const content = consumerChange.content;

  assert.match(
    content,
    /\{\s*localSymbol\s*\}\s*from\s*['"]\.\/barrel['"]/,
    'localSymbol must remain imported from barrel',
  );

  assert.match(
    content,
    /\{\s*symbolA\s*\}\s*from\s*['"]\.\/moduleA['"]/,
    'symbolA must be redirected to moduleA',
  );

  assert.match(
    content,
    /\{\s*symbolB\s*\}\s*from\s*['"]\.\/moduleB['"]/,
    'symbolB must be redirected to moduleB',
  );

  assert.notMatch(
    content,
    /\{[^}]*symbolA[^}]*\}\s*from\s*['"]\.\/barrel['"]/,
    'symbolA must NOT remain in barrel import',
  );
  assert.notMatch(
    content,
    /\{[^}]*symbolB[^}]*\}\s*from\s*['"]\.\/barrel['"]/,
    'symbolB must NOT remain in barrel import',
  );
});

test('applyImportChangesToFile splits mixed import with re-exports to different modules', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'consumer.ts',
    `import { localSymbol, symbolA, symbolB } from './barrel';
`,
  );

  const changes = [
    {
      symbolName: 'symbolA',
      currentModuleSpec: './barrel',
      newModuleSpec: './moduleA',
      isTypeOnly: false,
    },
    {
      symbolName: 'symbolB',
      currentModuleSpec: './barrel',
      newModuleSpec: './moduleB',
      isTypeOnly: false,
    },
  ];

  applyImportChangesToFile(sourceFile, changes, 'consumer.ts');

  const importDecls = sourceFile.getImportDeclarations();

  assert.equal(importDecls.length, 3);

  const barrelImport = importDecls.find(
    (d) => d.getModuleSpecifierValue() === './barrel',
  );
  assertDefined(barrelImport, 'barrel import missing');
  const barrelSymbols = barrelImport.getNamedImports().map((ni) => ni.getName());
  assert.deepEqual(barrelSymbols, ['localSymbol']);

  const moduleAImport = importDecls.find(
    (d) => d.getModuleSpecifierValue() === './moduleA',
  );
  assertDefined(moduleAImport, 'moduleA import missing');
  assert.deepEqual(
    moduleAImport.getNamedImports().map((ni) => ni.getName()),
    ['symbolA'],
  );

  const moduleBImport = importDecls.find(
    (d) => d.getModuleSpecifierValue() === './moduleB',
  );
  assertDefined(moduleBImport, 'moduleB import missing');
  assert.deepEqual(
    moduleBImport.getNamedImports().map((ni) => ni.getName()),
    ['symbolB'],
  );
});

test('applyImportChangesToFile preserves type-only on aliased symbols when splitting', () => {
  /*
    Regression: the allTypeOnly lookup in splitImportDeclaration used
    the alias (local name) to look up perSymbolTypeOnly, which is keyed
    by the original symbol name. Aliased per-symbol type imports were
    incorrectly emitted without the type keyword.
  */

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'consumer.ts',
    `import { localSymbol, type SomeType as AliasedType } from './barrel';
`,
  );

  const changes = [
    {
      symbolName: 'SomeType',
      currentModuleSpec: './barrel',
      newModuleSpec: './types',
      isTypeOnly: true,
    },
  ];

  applyImportChangesToFile(sourceFile, changes, 'consumer.ts');

  const imports = sourceFile.getImportDeclarations();
  assert.equal(imports.length, 2);

  const newImport = imports.find(
    (i) => i.getModuleSpecifierValue() === './types',
  );
  assertDefined(newImport, 'types import missing');
  assert.isTrue(newImport.isTypeOnly());
  const newNames = newImport.getNamedImports().map((ni) => ni.getName());
  assert.deepEqual(newNames, ['SomeType']);
  const newLocalNames = newImport.getNamedImports().map(
    (ni) => ni.compilerNode.name.getText(),
  );
  assert.deepEqual(newLocalNames, ['AliasedType']);

  const originalImport = imports.find(
    (i) => i.getModuleSpecifierValue() === './barrel',
  );
  assertDefined(originalImport, 'barrel import missing');
  const originalNames = originalImport
    .getNamedImports()
    .map((ni) => ni.getName());
  assert.deepEqual(originalNames, ['localSymbol']);
});

test('applyImportChangesToFile uses shortcut when all symbols redirect to same module', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const source = `import { parseModule, StaticModuleInfo } from './indexing';
`;

  const sf = project.createSourceFile('test.ts', source);

  const changes = [
    {
      symbolName: 'parseModule',
      currentModuleSpec: './indexing',
      newModuleSpec: './staticAnalysis',
      isTypeOnly: false,
    },
    {
      symbolName: 'StaticModuleInfo',
      currentModuleSpec: './indexing',
      newModuleSpec: './staticAnalysis',
      isTypeOnly: false,
    },
  ];

  applyImportChangesToFile(sf, changes, 'test.ts');

  const imports = sf.getImportDeclarations();
  assert.equal(imports.length, 1);

  // biome-ignore lint/style/noNonNullAssertion: assert.equal(imports.length, 1) guarantees index 0 is in bounds.
  const importDecl = imports[0]!;
  assert.equal(
    importDecl.getModuleSpecifierValue(),
    './staticAnalysis',
  );
  const symbols = importDecl.getNamedImports().map((ni) => ni.getName());
  assert.include(symbols, 'parseModule');
  assert.include(symbols, 'StaticModuleInfo');
});

test('applyImportChangesToFile preserves import aliases', () => {
  /*
    When a symbol is imported with an alias (e.g., `X as Y`), the alias must
    be preserved in the new import declaration. The change's symbolName is the
    original export name (X), but the code body references the alias (Y).
    Dropping the alias breaks compilation.
  */

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'consumer.ts',
    `import { resolveImportSpec as resolveImportSpecFromIndexing, resolveImportSpecAlias } from './indexing';
`,
  );

  const changes = [
    {
      symbolName: 'resolveImportSpec',
      currentModuleSpec: './indexing',
      newModuleSpec: './resolveImport',
      isTypeOnly: false,
    },
    {
      symbolName: 'resolveImportSpecAlias',
      currentModuleSpec: './indexing',
      newModuleSpec: './resolveImport',
      isTypeOnly: false,
    },
  ];

  applyImportChangesToFile(sourceFile, changes, 'consumer.ts');

  const imports = sourceFile.getImportDeclarations();
  assert.equal(imports.length, 1);

  // biome-ignore lint/style/noNonNullAssertion: assert.equal(imports.length, 1) guarantees index 0 is in bounds.
  const importDecl = imports[0]!;
  assert.equal(importDecl.getModuleSpecifierValue(), './resolveImport');

  const namedImports = importDecl.getNamedImports();
  const originalNames = namedImports.map((ni) => ni.getName());
  assert.include(originalNames, 'resolveImportSpec');
  assert.include(originalNames, 'resolveImportSpecAlias');

  const localNames = namedImports.map(
    (ni) => ni.compilerNode.name.getText(),
  );
  assert.include(localNames, 'resolveImportSpecFromIndexing');
});

test('applyImportChangesToFile preserves import aliases when splitting', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(
    'consumer.ts',
    `import { localSymbol, resolveImportSpec as resolveImportSpecFromIndexing, otherSymbol } from './indexing';
`,
  );

  const changes = [
    {
      symbolName: 'resolveImportSpec',
      currentModuleSpec: './indexing',
      newModuleSpec: './resolveImport',
      isTypeOnly: false,
    },
  ];

  applyImportChangesToFile(sourceFile, changes, 'consumer.ts');

  const imports = sourceFile.getImportDeclarations();
  assert.equal(imports.length, 2);

  const newImport = imports.find(
    (i) => i.getModuleSpecifierValue() === './resolveImport',
  );
  assertDefined(newImport, 'resolveImport import missing');
  const newNames = newImport.getNamedImports().map((ni) => ni.getName());
  assert.deepEqual(newNames, ['resolveImportSpec']);
  const newLocalNames = newImport.getNamedImports().map(
    (ni) => ni.compilerNode.name.getText(),
  );
  assert.deepEqual(newLocalNames, ['resolveImportSpecFromIndexing']);

  const originalImport = imports.find(
    (i) => i.getModuleSpecifierValue() === './indexing',
  );
  assertDefined(originalImport, 'indexing import missing');
  const originalNames = originalImport
    .getNamedImports()
    .map((ni) => ni.getName());
  assert.deepEqual(originalNames, ['localSymbol', 'otherSymbol']);
});
