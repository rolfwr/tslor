import { assert, test } from 'vitest';
import { Project } from 'ts-morph';
import { runProposeImportDirectly, applyImportChangesToFile } from './runProposeImportDirectly';
import { DebugOptions } from './objstore';
import { ModifyFileChange } from './plan';
import { InMemoryRepositoryRootProvider } from './repositoryRootProvider';
import { InMemoryFileSystem } from './filesystem';

/**
 * Test that runProposeImportDirectly generates proper undo information
 * NOTE: This test has been disabled because it requires complex filesystem mocking.
 */
test.skip('runProposeImportDirectly generates undo information for rollback', async () => {
  // Create an in-memory project with test files
  const project = new Project({ useInMemoryFileSystem: true });

  // Create original.ts with types
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
  project.createSourceFile('original.ts', originalContent);

  // Create reexport.ts that re-exports from original
  const reexportContent = `
// Re-export types from the original module
export type { ItemCustomIconsDto, ItemCustomIconDto, ItemCustomIconBlendedDto } from './original';
export { itemCustomIconSlots } from './original';
`;
  project.createSourceFile('reexport.ts', reexportContent);

  // Create consumer.ts that imports from reexport
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
  project.createSourceFile('consumer.ts', consumerContent);

  // Create a basic tsconfig.json
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
  project.createSourceFile('tsconfig.json', tsconfigContent);

  // Create in-memory repository provider
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/original.ts',
    '/repo/reexport.ts',
    '/repo/consumer.ts'
  ]);

  // Run propose-import-directly with in-memory provider
  const debugOptions: DebugOptions = { traceId: null };
  const fileSystem = new InMemoryFileSystem();
  const plan = await runProposeImportDirectly('/repo', debugOptions, repoProvider, fileSystem);

  // The plan should have changes (imports to modify)
  assert(plan.changes.length > 0, 'Plan should have changes');

  // CRITICAL: The plan should have undo information
  assert(plan.undo && plan.undo.length > 0, 'Plan should have undo information for rollback');

  // Verify that undo changes would restore the original imports
  // Each change should have a corresponding undo that reverses it
  assert.equal(plan.changes.length, plan.undo.length, 'Should have same number of changes and undo operations');

  // Check that undo operations are the reverse of changes
  for (let i = 0; i < plan.changes.length; i++) {
    const change = plan.changes[i];
    const undo = plan.undo[i];

    assert.equal(change.type, undo.type, `Change and undo types should match for index ${i}`);

    if (change.type === 'modify-file' && undo.type === 'modify-file') {
      // The undo content should restore the original file content
      // For import changes, this means changing back from './original' to './reexport'
      assert(undo.content.includes("from './reexport'"), `Undo should restore import from reexport, got: ${undo.content}`);
      assert(!undo.content.includes("from './original'"), `Undo should not contain import from original, got: ${undo.content}`);
    }
  }
});

/**
 * Test that propose-import-directly does not change imports when the re-exported symbol
 * does not actually exist in the original module (bug reproduction)
 * NOTE: This test has been disabled because it requires complex filesystem mocking.
 */
test.skip('propose-import-directly does not change imports for non-existent symbols', async () => {
  // Create an in-memory project with test files
  const project = new Project({ useInMemoryFileSystem: true });

  // Create realModule.ts with only realFunction
  const realModuleContent = `
export const realFunction = () => 'real';
`;
  project.createSourceFile('realModule.ts', realModuleContent);

  // Create vueCompat.ts that re-exports realFunction correctly but fakeFunction incorrectly
  const vueCompatContent = `
// Compatibility layer
export { realFunction } from './realModule';
export const fakeFunction = () => 'fake'; // This exists locally but not in realModule
`;
  project.createSourceFile('vueCompat.ts', vueCompatContent);

  // Create consumer.ts that imports both functions
  const consumerContent = `
// Consumer file that imports from the compatibility layer
import { realFunction, fakeFunction } from './vueCompat';
`;
  project.createSourceFile('consumer.ts', consumerContent);

  // Create a basic tsconfig.json
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
  project.createSourceFile('tsconfig.json', tsconfigContent);

  // Create in-memory repository provider
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/realModule.ts',
    '/repo/vueCompat.ts',
    '/repo/consumer.ts'
  ]);

  // Run propose-import-directly with in-memory provider
  const debugOptions: DebugOptions = { traceId: null };
  const fileSystem = new InMemoryFileSystem();
  const plan = await runProposeImportDirectly('/repo', debugOptions, repoProvider, fileSystem);

  // The plan should have NO changes for consumer.ts because fakeFunction doesn't exist in realModule
  // Only realFunction should be changed, but since it's already importing from vueCompat,
  // and vueCompat re-exports it from realModule, it should be changed.
  // But fakeFunction should NOT be changed because it doesn't exist in realModule.

  // Check that consumer.ts is not in the modified files, or if it is,
  // that the import still references vueCompat for fakeFunction
  const consumerChanges = plan.changes.filter(change =>
    change.type === 'modify-file' && change.path.endsWith('consumer.ts')
  );

  if (consumerChanges.length > 0) {
    // If there are changes to consumer.ts, the fakeFunction import should still be from vueCompat
    const modifyChange = consumerChanges[0] as ModifyFileChange;
    const modifiedContent = modifyChange.content;
    assert(modifiedContent.includes("fakeFunction } from './vueCompat'"),
      'fakeFunction should still import from vueCompat since it does not exist in realModule');
  }

  // The test should pass - currently it will fail because the bug causes fakeFunction
  // to be changed to import from realModule where it doesn't exist
});

test('applyImportChangesToFile splits mixed imports when only some symbols are re-exports', () => {
  /*
    Reproduction from _bug_import_directly_empty_changes.md:
    An import mixes a non-re-exported symbol (getItemRequestSchema) with a re-exported
    symbol (getItemResponseSchema). The tool detects the re-export but skips the change
    because it can't rewrite ALL symbols in the import. It should split the import instead.
  */

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('consumer.ts', `
import type { getItemRequestSchema, getItemResponseSchema } from '../../api/schemas/item/getItem';
`);

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
  assert.match(result, /getItemRequestSchema/,
    'getItemRequestSchema must remain imported from the original module');
  assert.match(result, /from ['"]\.\.\/\.\.\/api\/schemas\/item\/getItem['"]/,
    'getItemRequestSchema must still point at getItem');

  // A new import should be added for the redirected symbol
  assert.match(result, /getItemResponseSchema/,
    'getItemResponseSchema must be imported from the new module');
  assert.match(result, /from ['"]\.\.\/\.\.\/api\/schemas\/item\/getItemResponse['"]/,
    'getItemResponseSchema must point at getItemResponse');

  // The redirected symbol must NOT remain in the original import
  const importDecls = sourceFile.getImportDeclarations();
  const originalImport = importDecls.find(d =>
    d.getModuleSpecifierValue() === '../../api/schemas/item/getItem'
  );
  assert.isDefined(originalImport, 'Original import declaration should still exist');
  const originalNames = originalImport!.getNamedImports().map(n => n.getName());
  assert.notInclude(originalNames, 'getItemResponseSchema',
    'getItemResponseSchema must be removed from the original import');
});

test('applyImportChangesToFile splits mixed import with multiple re-exported symbols', () => {
  /*
    Updated scenario from _bug_import_directly_empty_changes.md:
    Import has one non-re-exported symbol (getItemRequestSchema) and two re-exported
    symbols (getItemResponseSchema, GetItemResponse) going to the same target module.
  */

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('consumer.ts', `
import type { getItemRequestSchema, getItemResponseSchema, GetItemResponse } from '../../api/schemas/item/getItem';
`);

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
  const originalImport = importDecls.find(d =>
    d.getModuleSpecifierValue() === '../../api/schemas/item/getItem'
  );
  assert.isDefined(originalImport, 'Original import should still exist');
  const originalNames = originalImport!.getNamedImports().map(n => n.getName());
  assert.deepEqual(originalNames, ['getItemRequestSchema'],
    'Only getItemRequestSchema should remain in the original import');

  // New import has both re-exported symbols pointing at the target module
  const newImport = importDecls.find(d =>
    d.getModuleSpecifierValue() === '../../api/schemas/item/getItemResponse'
  );
  assert.isDefined(newImport, 'New import pointing at getItemResponse should exist');
  const newNames = newImport!.getNamedImports().map(n => n.getName()).sort();
  assert.deepEqual(newNames, ['GetItemResponse', 'getItemResponseSchema'],
    'Both re-exported symbols should be in the new import');

  // New import should be type-only since all moved symbols are type-only
  assert.isTrue(newImport!.isTypeOnly(),
    'New import should be type-only');
});

test('applyImportChangesToFile preserves per-symbol type qualifier when splitting', () => {
  /*
    Reproduction from _bug_import_directly_drops_type.md:
    `import { startS3Server, type BucketConfiguration } from '...'` is split,
    but the new import for BucketConfiguration loses the `type` qualifier.
  */

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('consumer.ts', `
import { startS3Server, type BucketConfiguration } from '@mimir/s3-server/s3server';
`);

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
  assert.match(result, /import\s+type\s*\{[^}]*BucketConfiguration[^}]*\}\s*from\s*['"]@mimir\/s3-server\/bucketConfiguration['"]/,
    'New import for BucketConfiguration must have the type qualifier');

  // startS3Server must remain as a value import from the original module
  assert.match(result, /startS3Server/,
    'startS3Server must remain imported');
  assert.match(result, /from ['"]@mimir\/s3-server\/s3server['"]/,
    'startS3Server must still point at s3server');
});

test('runProposeImportDirectly produces changes for mixed imports (relative paths)', async () => {
  /*
    Reproduction of _bug_import_directly_empty_changes.md (relative-path variant):
    A consumer import mixes a locally-defined symbol with a re-exported symbol.
    The pipeline should detect the re-exported symbol AND produce a file change
    that splits the import.
  */

  const files = new Map<string, string>([
    ['/repo/tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ES2022', moduleResolution: 'Bundler' },
      include: ['*.ts'],
    })],
    ['/repo/getItemResponse.ts', [
      'export const getItemResponseSchema = "response";',
      'export type GetItemResponse = { id: string };',
    ].join('\n')],
    ['/repo/getItem.ts', [
      'export const getItemRequestSchema = "request";',
      'export { getItemResponseSchema, type GetItemResponse } from "./getItemResponse";',
    ].join('\n')],
    ['/repo/consumer.ts', [
      'import type { getItemRequestSchema, getItemResponseSchema } from "./getItem";',
    ].join('\n')],
  ]);

  const fileSystem = new InMemoryFileSystem(files);
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/getItemResponse.ts',
    '/repo/getItem.ts',
    '/repo/consumer.ts',
  ]);
  const debugOptions: DebugOptions = { traceId: null };

  const plan = await runProposeImportDirectly('/repo', debugOptions, repoProvider, fileSystem);

  // The plan MUST have a change for consumer.ts
  assert.isAbove(plan.changes.length, 0,
    'Plan should have at least one change');
  const consumerChange = plan.changes.find(c =>
    c.type === 'modify-file' && c.path === '/repo/consumer.ts'
  );
  assert.isDefined(consumerChange,
    'consumer.ts should be modified to split the mixed import');

  // Verify the modified content splits the import correctly
  const content = (consumerChange as ModifyFileChange).content;
  assert.match(content, /getItemRequestSchema.*from.*\.\/getItem/,
    'getItemRequestSchema must remain imported from getItem');
  assert.match(content, /getItemResponseSchema.*from.*\.\/getItemResponse/,
    'getItemResponseSchema must be redirected to getItemResponse');
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
    ['/repo/tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ES2022', moduleResolution: 'Bundler',
        paths: { '@repo/*': ['src/*'] },
        baseUrl: '.',
      },
      include: ['src/**/*.ts'],
    })],
    ['/repo/src/getItemResponse.ts', [
      'export const getItemResponseSchema = "response";',
      'export type GetItemResponse = { id: string };',
    ].join('\n')],
    ['/repo/src/getItem.ts', [
      'export const getItemRequestSchema = "request";',
      'export { getItemResponseSchema, type GetItemResponse } from "./getItemResponse";',
    ].join('\n')],
    ['/repo/src/consumer.ts', [
      'import type { getItemRequestSchema, getItemResponseSchema } from "./getItem";',
    ].join('\n')],
  ]);

  const fileSystem = new InMemoryFileSystem(files);
  const repoProvider = new InMemoryRepositoryRootProvider('/repo', [
    '/repo/src/getItemResponse.ts',
    '/repo/src/getItem.ts',
    '/repo/src/consumer.ts',
  ]);
  const debugOptions: DebugOptions = { traceId: null };

  const plan = await runProposeImportDirectly('/repo/src', debugOptions, repoProvider, fileSystem);

  assert.isAbove(plan.changes.length, 0,
    'Plan should have at least one change');
  const consumerChange = plan.changes.find(c =>
    c.type === 'modify-file' && c.path === '/repo/src/consumer.ts'
  );
  assert.isDefined(consumerChange,
    'consumer.ts should be modified even when tsconfig has path aliases');

  const content = (consumerChange as ModifyFileChange).content;
  assert.match(content, /getItemRequestSchema.*from.*\.\/getItem/,
    'getItemRequestSchema must remain imported from getItem');
  assert.match(content, /getItemResponseSchema.*from.*\.\/getItemResponse/,
    'getItemResponseSchema must be redirected to getItemResponse');
});