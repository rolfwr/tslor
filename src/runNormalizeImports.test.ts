import { test, assert } from 'vitest';
import { Project, SourceFile } from 'ts-morph';
import { normalizeImportsInFile } from './runNormalizeImports';

function normalize(source: string): { changed: boolean; result: string } {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('test.ts', source);
  const changed = normalizeImportsInFile(sourceFile);
  return { changed, result: sourceFile.getFullText() };
}

test('Merge two type-only imports from same module', () => {
  const { changed, result } = normalize(`
import type { A } from './mod';
import type { B } from './mod';
`);
  assert.isTrue(changed);
  assert.include(result, 'A');
  assert.include(result, 'B');
  assert.notInclude(result, "import type { B } from './mod'");
  // Should have exactly one import from ./mod
  assert.equal(result.match(/from '\.\/mod'/g)?.length, 1);
});

test('Merge two value imports from same module', () => {
  const { changed, result } = normalize(`
import { foo } from './utils';
import { bar } from './utils';
`);
  assert.isTrue(changed);
  assert.include(result, 'foo');
  assert.include(result, 'bar');
  assert.equal(result.match(/from '\.\/utils'/g)?.length, 1);
});

test('Do not merge type-only with value imports', () => {
  const { changed, result } = normalize(`
import type { MyType } from './mod';
import { myFunc } from './mod';
`);
  assert.isFalse(changed);
  assert.equal(result.match(/from '\.\/mod'/g)?.length, 2);
});

test('Preserve inline type annotations when merging value imports', () => {
  const { changed, result } = normalize(`
import { type Foo } from './mod';
import { bar } from './mod';
`);
  assert.isTrue(changed);
  assert.equal(result.match(/from '\.\/mod'/g)?.length, 1);
  assert.include(result, 'type Foo');
  assert.include(result, 'bar');
});

test('Merge three or more imports from same module', () => {
  const { changed, result } = normalize(`
import { A } from './mod';
import { B } from './mod';
import { C } from './mod';
`);
  assert.isTrue(changed);
  assert.equal(result.match(/from '\.\/mod'/g)?.length, 1);
  assert.include(result, 'A');
  assert.include(result, 'B');
  assert.include(result, 'C');
});

test('Merge default import with named imports', () => {
  const { changed, result } = normalize(`
import React from 'react';
import { useState } from 'react';
`);
  assert.isTrue(changed);
  assert.equal(result.match(/from 'react'/g)?.length, 1);
  assert.include(result, 'React');
  assert.include(result, 'useState');
});

test('Do not merge namespace imports', () => {
  const { changed, result } = normalize(`
import * as fs from 'fs';
import { readFile } from 'fs';
`);
  assert.isFalse(changed);
  assert.equal(result.match(/from 'fs'/g)?.length, 2);
});

test('Skip side-effect imports', () => {
  const { changed, result } = normalize(`
import './polyfill';
import { something } from './polyfill';
`);
  assert.isFalse(changed);
  assert.include(result, "import './polyfill'");
  assert.include(result, "import { something } from './polyfill'");
});

test('Deduplicate overlapping names', () => {
  const { changed, result } = normalize(`
import { A, B } from './mod';
import { A, C } from './mod';
`);
  assert.isTrue(changed);
  assert.equal(result.match(/from '\.\/mod'/g)?.length, 1);
  // A should appear only once in the import
  const importLine = result.split('\n').find(l => l.includes("from './mod'"))!;
  assert.equal(importLine.match(/\bA\b/g)?.length, 1);
  assert.include(importLine, 'B');
  assert.include(importLine, 'C');
});

test('Do not merge imports from different modules', () => {
  const { changed, result } = normalize(`
import { A } from './mod1';
import { B } from './mod2';
`);
  assert.isFalse(changed);
  assert.include(result, "from './mod1'");
  assert.include(result, "from './mod2'");
});

test('No-op when nothing to merge', () => {
  const { changed, result } = normalize(`
import { A } from './mod1';
import type { B } from './mod2';
import * as path from 'path';
`);
  assert.isFalse(changed);
});

test('Preserve import aliases', () => {
  const { changed, result } = normalize(`
import { foo as bar } from './mod';
import { baz } from './mod';
`);
  assert.isTrue(changed);
  assert.equal(result.match(/from '\.\/mod'/g)?.length, 1);
  assert.include(result, 'foo as bar');
  assert.include(result, 'baz');
});

test('Merge multiple independent groups', () => {
  const { changed, result } = normalize(`
import { A } from './x';
import { B } from './y';
import { C } from './x';
import { D } from './y';
`);
  assert.isTrue(changed);
  assert.equal(result.match(/from '\.\/x'/g)?.length, 1);
  assert.equal(result.match(/from '\.\/y'/g)?.length, 1);
});

test('Conflicting default imports are not merged', () => {
  const { changed, result } = normalize(`
import A from './mod';
import B from './mod';
`);
  // The second has a conflicting default — skip its merge
  assert.isFalse(changed);
  assert.equal(result.match(/from '\.\/mod'/g)?.length, 2);
});

test('Do not merge default import into type-only import (ts-morph limitation)', () => {
  const { changed, result } = normalize(`
import type { CreateGroupDto, UpdateGroupDto } from '@mimir/common/dto/groupModel';
import type GroupModel from '@mimir/common/dto/groupModel';
`);
  // Cannot merge because setDefaultImport on type-only import produces invalid syntax
  assert.isFalse(changed);
  assert.equal(result.match(/from '@mimir\/common\/dto\/groupModel'/g)?.length, 2);
});

test('Merge named-only type imports even when group has an unmergeable default', () => {
  const { changed, result } = normalize(`
import type { A } from './mod';
import type Default from './mod';
import type { B } from './mod';
`);
  // A and B should merge into the first, but Default cannot merge into it
  assert.isTrue(changed);
  // First import gets A + B, default stays separate
  assert.equal(result.match(/from '\.\/mod'/g)?.length, 2);
});

test('Do not merge type-only default with type-only named (TS1363)', () => {
  // TypeScript does not allow: import type Default, { Named } from '...'
  const { changed, result } = normalize(`
import type TranscriptWord from './transcriptWord';
import type { Word } from './transcriptWord';
`);
  assert.isFalse(changed);
  assert.equal(result.match(/from '\.\/transcriptWord'/g)?.length, 2);
});

test('Do not merge type-only named into type-only default (TS1363 reverse)', () => {
  const { changed, result } = normalize(`
import type { Word } from './transcriptWord';
import type TranscriptWord from './transcriptWord';
`);
  assert.isFalse(changed);
  assert.equal(result.match(/from '\.\/transcriptWord'/g)?.length, 2);
});

test('Merge named imports into declaration that already has default', () => {
  const { changed, result } = normalize(`
import React, { useState } from 'react';
import { useEffect } from 'react';
`);
  assert.isTrue(changed);
  assert.equal(result.match(/from 'react'/g)?.length, 1);
  assert.include(result, 'React');
  assert.include(result, 'useState');
  assert.include(result, 'useEffect');
});
