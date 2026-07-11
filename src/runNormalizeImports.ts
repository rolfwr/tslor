/**
 * Normalize Imports Command
 *
 * Merges duplicate import declarations from the same module within each file.
 * Two imports are merged if they share the same module specifier and the same
 * import kind (both type-only or both value). Does not merge namespace or
 * side-effect imports.
 */

import { Identifier, ImportDeclaration, SourceFile } from 'ts-morph';
import { groupBy } from './collections';
import { FileSystem, reinsertScript } from './filesystem';
import { loadSourceFile } from './loadSourceFile';
import { isPathWithinDirectory, normalizeAndValidatePath } from './pathUtils';
import {
  computeStringChecksum,
  displayPlan,
  ModifyFileChange,
  PLAN_FILE_NAME,
  PLAN_VERSION,
  TslorPlan,
  writePlan,
} from './plan';
import {
  InMemoryRepositoryRootProvider,
  RepositoryRootProvider,
} from './repositoryRootProvider';

export async function runNormalizeImports(
  directoryArg: string,
  repoProvider: RepositoryRootProvider,
  fileSystem: FileSystem,
  writer: (message: string) => void,
  cwd: string,
): Promise<TslorPlan> {
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;
  const directory = normalizeAndValidatePath(
    directoryArg,
    'Directory',
    isInMemory,
  );
  writer(`Scanning for mergeable imports in ${directory}...\n`);

  const repoRoot = repoProvider.findRepositoryRoot(directory);
  const allPaths = await repoProvider.getTypeScriptFilePaths(
    repoRoot,
    fileSystem,
  );
  const filteredPaths = allPaths.filter((path: string) =>
    isPathWithinDirectory(path, directory),
  );

  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = [];
  const sourceFiles = new Set<string>();
  const checksums: { [filePath: string]: string } = {};

  for (const filePath of filteredPaths) {
    let originalContent: string;
    try {
      originalContent = await fileSystem.readFile(filePath);
    } catch {
      continue;
    }

    const sourceFile = await loadSourceFile(filePath, fileSystem);
    const { changed, conflicts } = normalizeImportsInFile(sourceFile);

    for (const c of conflicts) {
      writer(
        `Warning: conflicting default imports from '${c.module}': ` +
          `'${c.winnerDefault}' vs '${c.donorDefault}'. Skipping merge of this declaration.\n`,
      );
    }

    if (!changed) {
      continue;
    }

    const modifiedScriptContent = sourceFile.getFullText();
    let finalContent: string;
    if (filePath.endsWith('.vue')) {
      finalContent = reinsertScript(originalContent, modifiedScriptContent);
    } else {
      finalContent = modifiedScriptContent;
    }

    if (finalContent !== originalContent) {
      const fileChecksum = computeStringChecksum(originalContent);
      changes.push({
        type: 'modify-file',
        path: filePath,
        content: finalContent,
        originalChecksum: fileChecksum,
      });
      undo.push({
        type: 'modify-file',
        path: filePath,
        content: originalContent,
        originalChecksum: computeStringChecksum(finalContent),
      });
      sourceFiles.add(filePath);
      checksums[filePath] = fileChecksum;
    }
  }

  const plan: TslorPlan = {
    version: PLAN_VERSION,
    command: 'normalize-imports',
    timestamp: new Date().toISOString(),
    sourceFiles: Array.from(sourceFiles),
    targetFiles: [],
    checksums,
    changes,
    undo,
  };

  if (changes.length === 0) {
    writer('No mergeable imports found.\n');
  } else {
    writer(`Found ${changes.length} files with mergeable imports\n`);
    await writePlan(plan, PLAN_FILE_NAME);
    await displayPlan(plan, {}, cwd, writer);
  }

  return plan;
}

/**
 * Information about a conflicting default import that prevented a merge.
 */
export interface ImportConflict {
  module: string;
  winnerDefault: string | undefined;
  donorDefault: string;
}

/**
 * Merge duplicate import declarations in a source file.
 * Returns whether any changes were made and any conflicts that prevented merges.
 */
export function normalizeImportsInFile(sourceFile: SourceFile): {
  changed: boolean;
  conflicts: ImportConflict[];
} {
  const imports = sourceFile.getImportDeclarations();

  const groups = groupBy(
    imports.filter((d) => !isSideEffectImport(d) && !d.getNamespaceImport()),
    (d) => `${d.getModuleSpecifierValue()}\0${d.isTypeOnly()}`,
  );

  let changed = false;
  const conflicts: ImportConflict[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const result = mergeImportGroup(group);
    if (result.changed) {
      changed = true;
    }
    conflicts.push(...result.conflicts);
  }

  return { changed, conflicts };
}

function mergeImportGroup(group: ImportDeclaration[]): {
  changed: boolean;
  conflicts: ImportConflict[];
} {
  // biome-ignore lint/style/noNonNullAssertion: caller guarantees group.length >= 2
  const winner = group[0]!;
  const winnerDefaultName = winner.getDefaultImport()?.getText();
  const winnerComments = leadingCommentTexts(winner);
  let changed = false;
  const conflicts: ImportConflict[] = [];

  for (const [i, donor] of group.entries()) {
    if (i === 0) {
      continue;
    }
    const result = tryMergeDonorIntoWinner(
      winner,
      donor,
      winnerDefaultName,
      winnerComments,
    );
    if (result.merged) {
      changed = true;
    } else if (result.conflictName !== undefined) {
      conflicts.push({
        module: winner.getModuleSpecifierValue(),
        winnerDefault: winnerDefaultName,
        donorDefault: result.conflictName,
      });
    }
  }

  return { changed, conflicts };
}

function tryMergeDonorIntoWinner(
  winner: ImportDeclaration,
  donor: ImportDeclaration,
  winnerDefaultName: string | undefined,
  winnerComments: string[],
): { merged: true } | { merged: false; conflictName?: string } {
  /*
    Don't merge imports with different leading comments — they may be
    build directives (e.g., a VUE2 marker) that control conditional compilation.
  */
  if (!leadingCommentsEqual(winnerComments, leadingCommentTexts(donor))) {
    return { merged: false };
  }

  /*
    TypeScript forbids `import type Default, { Named } from '...'` (TS1363).
    Skip merge if the result would have both a default and named imports on a type-only import.
  */
  if (wouldViolateTypeOnlyRestriction(winner, donor, winnerDefaultName)) {
    return { merged: false };
  }

  const defaultResult = mergeDefaultImport(winner, donor, winnerDefaultName);
  if (!defaultResult.merged) {
    return { merged: false, conflictName: defaultResult.conflict };
  }

  mergeNamedImports(winner, donor);
  donor.remove();
  return { merged: true };
}

function wouldViolateTypeOnlyRestriction(
  winner: ImportDeclaration,
  donor: ImportDeclaration,
  winnerDefaultName: string | undefined,
): boolean {
  if (!winner.isTypeOnly()) {
    return false;
  }
  const mergedHasDefault =
    Boolean(winnerDefaultName) || Boolean(donor.getDefaultImport());
  const mergedHasNamed =
    winner.getNamedImports().length > 0 || donor.getNamedImports().length > 0;
  return mergedHasDefault && mergedHasNamed;
}

/**
 * Merges the default import from donor into winner.
 * Returns `{ merged: true }` on success, or `{ merged: false, conflict: name }` on conflict.
 */
function mergeDefaultImport(
  winner: ImportDeclaration,
  donor: ImportDeclaration,
  winnerDefaultName: string | undefined,
): { merged: true } | { merged: false; conflict: string } {
  const donorDefault = donor.getDefaultImport();
  if (!donorDefault) {
    return { merged: true };
  }
  if (!winnerDefaultName) {
    winner.setDefaultImport(donorDefault.getText());
    return { merged: true };
  }
  if (winnerDefaultName !== donorDefault.getText()) {
    return { merged: false, conflict: donorDefault.getText() };
  }
  return { merged: true };
}

function mergeNamedImports(
  winner: ImportDeclaration,
  donor: ImportDeclaration,
): void {
  const existingNames = new Set(
    winner.getNamedImports().map((ni) => namedImportKey(ni)),
  );

  for (const namedImport of donor.getNamedImports()) {
    const key = namedImportKey(namedImport);
    if (existingNames.has(key)) {
      continue;
    }
    const alias = namedImport.getAliasNode();
    winner.addNamedImport({
      name: namedImport.getName(),
      ...(alias ? { alias: alias.getText() } : {}),
      ...(namedImport.isTypeOnly() ? { isTypeOnly: true } : {}),
    });
    existingNames.add(key);
  }
}

function isSideEffectImport(importDecl: ImportDeclaration): boolean {
  return !importDecl.getImportClause();
}

function leadingCommentTexts(node: ImportDeclaration): string[] {
  return node.getLeadingCommentRanges().map((r) => r.getText());
}

function leadingCommentsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((text, i) => text === b[i]);
}

function namedImportKey(namedImport: {
  getName(): string;
  getAliasNode(): Identifier | undefined;
}): string {
  const alias = namedImport.getAliasNode();
  return alias
    ? `${namedImport.getName()} as ${alias.getText()}`
    : namedImport.getName();
}
