import { SourceFile, SyntaxKind, ImportDeclaration, PropertyAccessExpression, QualifiedName, Node } from 'ts-morph';
import { promises as fsp } from 'fs';
import { RepositoryRootProvider, InMemoryRepositoryRootProvider } from './repositoryRootProvider';
import { FileSystem } from './filesystem';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath } from './pathUtils';
import { TslorPlan, PLAN_VERSION, PLAN_FILE_NAME, computeFileChecksum, computeStringChecksum, writePlan, displayPlan, ModifyFileChange } from './plan';
import { loadSourceFile, NODEJS_GLOBALS } from './indexing';
import { openStorage } from './storage';
import { reinsertScript } from './transformingFileSystem';

export interface NamespaceNormalizationChange {
  moduleSpec: string;
  accessedMembers: string[];
}

/**
 * Analyze a source file for namespace imports (import * as X) and convert them
 * to explicit named imports by finding all X.member property access patterns.
 *
 * Modifies the source file in place and returns information about what was changed.
 *
 * Skips namespace imports that:
 * - Have no member access (namespace used as a value)
 * - Would cause name conflicts with existing local bindings
 */
export function normalizeNamespaceImportsInFile(sourceFile: SourceFile): NamespaceNormalizationChange[] {
  const changes: NamespaceNormalizationChange[] = [];

  // Collect all namespace imports
  const namespaceImports: Array<{
    decl: ImportDeclaration;
    nsName: string;
    moduleSpec: string;
    isTypeOnly: boolean;
  }> = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const nsImport = importDecl.getNamespaceImport();
    if (!nsImport) {
      continue;
    }

    const moduleSpec = importDecl.getModuleSpecifierValue();
    namespaceImports.push({
      decl: importDecl,
      nsName: nsImport.getText(),
      moduleSpec,
      isTypeOnly: importDecl.isTypeOnly(),
    });
  }

  if (namespaceImports.length === 0) {
    return changes;
  }

  /*
    Collect all identifiers in the file that are NOT part of the import declarations
    to detect potential name conflicts
  */
  const existingBindings = collectExistingBindings(sourceFile, new Set(namespaceImports.map(ns => ns.nsName)));

  // Process each namespace import (in reverse order to preserve positions)
  for (const nsImport of namespaceImports.reverse()) {
    const result = processNamespaceImport(sourceFile, nsImport.decl, nsImport.nsName, nsImport.moduleSpec, nsImport.isTypeOnly, existingBindings);
    if (result) {
      changes.push(result);
    }
  }

  changes.reverse();
  return changes;
}

/**
 * Propose normalizing namespace imports in a directory.
 * Scans all TypeScript files, converts `import * as X` to explicit named imports,
 * and produces a tslor plan.
 */
export async function runNormalizeNamespaceImports(
  directoryArg: string,
  debugOptions: DebugOptions,
  repoProvider: RepositoryRootProvider,
  fileSystem: FileSystem,
): Promise<TslorPlan> {
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;
  const directory = normalizeAndValidatePath(directoryArg, "Directory", isInMemory);

  const repoRoot = repoProvider.findRepositoryRoot(directory);

  /*
    Use the index to find only files that have namespace imports,
    rather than loading every TypeScript file through ts-morph.
  */
  const db = openStorage(debugOptions, true);
  const allPaths = await repoProvider.getTypeScriptFilePaths(repoRoot, true);

  const { indexImportFromFiles } = await import('./indexing');
  await indexImportFromFiles(allPaths, db, repoRoot, true, fileSystem);
  db.save();

  // Query the index for all namespace imports (symbolName|*)
  const namespaceImportObjs = db.getSymbolImports('*');
  const filesWithNamespaceImports = new Set<string>();
  for (const obj of namespaceImportObjs) {
    // id format: import|{importerPath}|{index}
    const importerPath = obj.id.slice('import|'.length, obj.id.lastIndexOf('|'));
    if (importerPath.startsWith(directory)) {
      filesWithNamespaceImports.add(importerPath);
    }
  }

  if (filesWithNamespaceImports.size === 0) {
    console.log('No namespace imports found in the codebase.');
    return createEmptyPlan();
  }

  console.log(`Found ${filesWithNamespaceImports.size} file(s) with namespace imports`);

  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = [];
  const sourceFiles: string[] = [];
  const checksums: { [filePath: string]: string } = {};
  let totalNormalized = 0;
  let totalSkipped = 0;

  for (const filePath of filesWithNamespaceImports) {
    const originalContent = await fsp.readFile(filePath, 'utf-8');
    const sourceFile = await loadSourceFile(filePath, fileSystem);

    const fileChanges = normalizeNamespaceImportsInFile(sourceFile);
    if (fileChanges.length === 0) {
      // Check if there were namespace imports that were skipped
      const importDecls = sourceFile.getImportDeclarations();
      for (const decl of importDecls) {
        if (decl.getNamespaceImport()) totalSkipped++;
      }
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
      const fileChecksum = await computeFileChecksum(filePath);
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
      sourceFiles.push(filePath);
      checksums[filePath] = fileChecksum;
      totalNormalized += fileChanges.length;
    }
  }

  if (totalNormalized === 0) {
    console.log('No namespace imports to normalize.');
    if (totalSkipped > 0) {
      console.log(`Skipped ${totalSkipped} namespace import(s) that could not be safely normalized (name conflicts or non-member-access usage).`);
    }
    return createEmptyPlan();
  }

  console.log(`Normalized ${totalNormalized} namespace import(s) across ${sourceFiles.length} file(s)`);
  if (totalSkipped > 0) {
    console.log(`Skipped ${totalSkipped} namespace import(s) that could not be safely normalized.`);
  }

  const plan: TslorPlan = {
    version: PLAN_VERSION,
    command: 'normalize-namespace-imports',
    timestamp: new Date().toISOString(),
    sourceFiles,
    targetFiles: [],
    checksums,
    changes,
    undo,
  };

  await writePlan(plan, PLAN_FILE_NAME);
  await displayPlan(plan);

  return plan;
}

function createEmptyPlan(): TslorPlan {
  return {
    version: PLAN_VERSION,
    command: 'normalize-namespace-imports',
    timestamp: new Date().toISOString(),
    sourceFiles: [],
    targetFiles: [],
    checksums: {},
    changes: [],
    undo: [],
  };
}

function collectExistingBindings(sourceFile: SourceFile, namespaceNames: Set<string>): Set<string> {
  const bindings = new Set<string>();

  /*
    Collect ALL variable declarations at every nesting level (not just top-level)
    to detect conflicts like `const x = ns.x` inside function bodies
  */
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    bindings.add(decl.getName());
  }
  for (const param of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
    bindings.add(param.getName());
  }
  for (const fn of sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    const name = fn.getName();
    if (name) bindings.add(name);
  }
  for (const cls of sourceFile.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
    const name = cls.getName();
    if (name) bindings.add(name);
  }
  for (const iface of sourceFile.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)) {
    bindings.add(iface.getName());
  }
  for (const typeAlias of sourceFile.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration)) {
    bindings.add(typeAlias.getName());
  }
  for (const enumDecl of sourceFile.getDescendantsOfKind(SyntaxKind.EnumDeclaration)) {
    bindings.add(enumDecl.getName());
  }

  // Add Node.js globals that namespace member names must not shadow
  for (const name of NODEJS_GLOBALS) {
    bindings.add(name);
  }

  // Collect named imports from other import declarations (not namespace ones we're processing)
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const nsImport = importDecl.getNamespaceImport();
    if (nsImport && namespaceNames.has(nsImport.getText())) {
      continue;
    }

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) bindings.add(defaultImport.getText());

    for (const named of importDecl.getNamedImports()) {
      bindings.add(named.getName());
    }
  }

  return bindings;
}

function processNamespaceImport(
  sourceFile: SourceFile,
  importDecl: ImportDeclaration,
  nsName: string,
  moduleSpec: string,
  isTypeOnly: boolean,
  existingBindings: Set<string>,
): NamespaceNormalizationChange | null {
  /*
    Find all PropertyAccessExpression and QualifiedName nodes where the
    left side is the namespace identifier
  */
  const memberAccessNodes: Array<{ node: Node; memberName: string; isTypePosition: boolean }> = [];
  let namespaceUsedAsValue = false;

  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== nsName) {
      continue;
    }

    // Skip the identifier in the import declaration itself
    const ancestor = id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (ancestor === importDecl) {
      continue;
    }

    const parent = id.getParent();

    // Value position: X.member as PropertyAccessExpression
    if (parent && parent.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = parent as PropertyAccessExpression;
      if (propAccess.getExpression() === id) {
        memberAccessNodes.push({ node: propAccess, memberName: propAccess.getName(), isTypePosition: false });
        continue;
      }
    }

    // Type position: X.Member as QualifiedName
    if (parent && parent.getKind() === SyntaxKind.QualifiedName) {
      const qualifiedName = parent as QualifiedName;
      if (qualifiedName.getLeft() === id) {
        memberAccessNodes.push({ node: qualifiedName, memberName: qualifiedName.getRight().getText(), isTypePosition: true });
        continue;
      }
    }

    // Namespace is used in a non-member-access context (e.g., passed as argument)
    namespaceUsedAsValue = true;
  }

  if (namespaceUsedAsValue || memberAccessNodes.length === 0) {
    return null;
  }

  // Collect accessed member names and track whether each is type-only
  const accessedMembers = new Set<string>();
  const memberHasValueUse = new Set<string>();
  for (const access of memberAccessNodes) {
    accessedMembers.add(access.memberName);
    if (!access.isTypePosition) {
      memberHasValueUse.add(access.memberName);
    }
  }

  // Check for name conflicts
  for (const member of accessedMembers) {
    if (existingBindings.has(member)) {
      return null;
    }
  }

  // All checks passed — apply the transformation

  // Replace all X.member with just member (process in reverse order to preserve positions)
  const sortedAccesses = [...memberAccessNodes].sort((a, b) => b.node.getStart() - a.node.getStart());
  for (const access of sortedAccesses) {
    access.node.replaceWithText(access.memberName);
  }

  // Replace the import declaration
  const sortedMembers = [...accessedMembers].sort();
  if (isTypeOnly) {
    // Original was `import type * as X` — all members are type-only
    const membersStr = sortedMembers.join(', ');
    importDecl.replaceWithText(`import type { ${membersStr} } from '${moduleSpec}';`);
  } else {
    // Use inline `type` keyword for members only used in type positions
    const membersStr = sortedMembers
      .map(m => memberHasValueUse.has(m) ? m : `type ${m}`)
      .join(', ');
    importDecl.replaceWithText(`import { ${membersStr} } from '${moduleSpec}';`);
  }

  return {
    moduleSpec,
    accessedMembers: sortedMembers,
  };
}
