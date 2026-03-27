/**
 * Normalize Imports Command
 *
 * Merges duplicate import declarations from the same module within each file.
 * Two imports are merged if they share the same module specifier and the same
 * import kind (both type-only or both value). Does not merge namespace or
 * side-effect imports.
 */

import { DebugOptions } from "./objstore";
import { normalizeAndValidatePath } from "./pathUtils";
import { TslorPlan, PLAN_VERSION, PLAN_FILE_NAME, computeFileChecksum, computeStringChecksum, writePlan, displayPlan, ModifyFileChange } from "./plan";
import { promises as fsp } from "fs";
import { SourceFile, ImportDeclaration } from "ts-morph";
import { loadSourceFile } from "./indexing";
import { reinsertScript } from "./transformingFileSystem";
import { RepositoryRootProvider, InMemoryRepositoryRootProvider } from "./repositoryRootProvider";
import { FileSystem } from "./filesystem";

export async function runNormalizeImports(
  directoryArg: string,
  debugOptions: DebugOptions,
  repoProvider: RepositoryRootProvider,
  fileSystem: FileSystem
): Promise<TslorPlan> {
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;
  const directory = normalizeAndValidatePath(directoryArg, "Directory", isInMemory);
  console.log(`Scanning for mergeable imports in ${directory}...`);

  const repoRoot = repoProvider.findRepositoryRoot(directory);
  const allPaths = await repoProvider.getTypeScriptFilePaths(repoRoot, true);
  const filteredPaths = allPaths.filter((path: string) => path.startsWith(directory));

  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = [];
  const sourceFiles = new Set<string>();
  const checksums: { [filePath: string]: string } = {};

  for (const filePath of filteredPaths) {
    let originalContent: string;
    try {
      originalContent = await fsp.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const sourceFile = await loadSourceFile(filePath, fileSystem);
    const changed = normalizeImportsInFile(sourceFile);

    if (!changed) continue;

    const modifiedScriptContent = sourceFile.getFullText();
    let finalContent: string;
    if (filePath.endsWith('.vue')) {
      finalContent = reinsertScript(originalContent, modifiedScriptContent);
    } else {
      finalContent = modifiedScriptContent;
    }

    if (finalContent !== originalContent) {
      const fileChecksum = await computeFileChecksum(filePath);
      changes.push({
        type: 'modify-file',
        path: filePath,
        content: finalContent,
        originalChecksum: fileChecksum
      });
      undo.push({
        type: 'modify-file',
        path: filePath,
        content: originalContent,
        originalChecksum: computeStringChecksum(finalContent)
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
    undo
  };

  if (changes.length === 0) {
    console.log('No mergeable imports found.');
  } else {
    console.log(`Found ${changes.length} files with mergeable imports`);
    await writePlan(plan, PLAN_FILE_NAME);
    await displayPlan(plan);
  }

  return plan;
}

/**
 * Merge duplicate import declarations in a source file.
 * Returns true if any changes were made.
 */
export function normalizeImportsInFile(sourceFile: SourceFile): boolean {
  const imports = sourceFile.getImportDeclarations();

  // Group mergeable imports by (moduleSpecifier, isTypeOnly)
  const groups = new Map<string, ImportDeclaration[]>();

  for (const importDecl of imports) {
    if (isSideEffectImport(importDecl)) continue;
    if (importDecl.getNamespaceImport()) continue;

    const moduleSpec = importDecl.getModuleSpecifierValue();
    const isTypeOnly = importDecl.isTypeOnly();
    const key = `${moduleSpec}\0${isTypeOnly}`;

    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(importDecl);
  }

  let changed = false;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const winner = group[0];
    const winnerDefaultName = winner.getDefaultImport()?.getText();

    for (let i = 1; i < group.length; i++) {
      const donor = group[i];

      // Handle default import
      const donorDefault = donor.getDefaultImport();

      // TypeScript forbids `import type Default, { Named } from '...'` (TS1363).
      // Skip merge if the result would have both a default and named imports on a type-only import.
      if (winner.isTypeOnly()) {
        const mergedHasDefault = Boolean(winnerDefaultName) || Boolean(donorDefault);
        const mergedHasNamed = winner.getNamedImports().length > 0 || donor.getNamedImports().length > 0;
        if (mergedHasDefault && mergedHasNamed) {
          continue;
        }
      }

      if (donorDefault) {
        if (!winnerDefaultName) {
          winner.setDefaultImport(donorDefault.getText());
        } else if (winnerDefaultName !== donorDefault.getText()) {
          console.warn(
            `Warning: conflicting default imports from '${winner.getModuleSpecifierValue()}': ` +
            `'${winnerDefaultName}' vs '${donorDefault.getText()}'. Skipping merge of this declaration.`
          );
          continue;
        }
      }

      // Merge named imports
      const existingNames = new Set(
        winner.getNamedImports().map(ni => namedImportKey(ni))
      );

      for (const namedImport of donor.getNamedImports()) {
        const key = namedImportKey(namedImport);
        if (existingNames.has(key)) continue;

        const alias = namedImport.getAliasNode();
        winner.addNamedImport({
          name: namedImport.getName(),
          ...(alias ? { alias: alias.getText() } : {}),
          ...(namedImport.isTypeOnly() ? { isTypeOnly: true } : {}),
        });
        existingNames.add(key);
      }

      donor.remove();
      changed = true;
    }
  }

  return changed;
}

function isSideEffectImport(importDecl: ImportDeclaration): boolean {
  return !importDecl.getImportClause();
}

function namedImportKey(namedImport: { getName(): string; getAliasNode(): any }): string {
  const alias = namedImport.getAliasNode();
  return alias ? `${namedImport.getName()} as ${alias.getText()}` : namedImport.getName();
}
