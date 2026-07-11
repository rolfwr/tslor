import {
  SourceFile,
  SyntaxKind,
  ImportDeclaration,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertySignature,
  QualifiedName,
  Node,
  Identifier,
  BindingElement,
  EnumMember,
  PropertyDeclaration,
  MethodDeclaration,
  MethodSignature,
  GetAccessorDeclaration,
  SetAccessorDeclaration,
  ParameterDeclaration,
} from 'ts-morph';
import { promises as fsp } from 'fs';
import {
  RepositoryRootProvider,
  InMemoryRepositoryRootProvider,
} from './repositoryRootProvider';
import { FileSystem, reinsertScript } from './filesystem';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath, isPathWithinDirectory } from './pathUtils';
import {
  TslorPlan,
  PLAN_VERSION,
  PLAN_FILE_NAME,
  computeFileChecksum,
  computeStringChecksum,
  writePlan,
  displayPlan,
  ModifyFileChange,
  createEmptyPlan,
} from './plan';
import { openStorage } from './storage';
import { isGeneratedFile } from './generatedFileDetection';
import { loadSourceFile } from './loadSourceFile';

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
export function normalizeNamespaceImportsInFile(
  sourceFile: SourceFile,
): NamespaceNormalizationChange[] {
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

  const existingBindings = collectExistingBindings(
    sourceFile,
    new Set(namespaceImports.map((ns) => ns.nsName)),
  );

  // Process each namespace import (in reverse order to preserve positions)
  for (const nsImport of namespaceImports.reverse()) {
    const result = processNamespaceImport(
      sourceFile,
      nsImport.decl,
      nsImport.nsName,
      nsImport.moduleSpec,
      nsImport.isTypeOnly,
      existingBindings,
    );
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
function countSkippedNamespaceImports(sourceFile: SourceFile): number {
  let count = 0;
  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getNamespaceImport()) {
      count++;
    }
  }
  return count;
}

interface FileNamespaceResult {
  normalizedCount: number;
  skippedCount: number;
  change: ModifyFileChange | null;
  undoChange: ModifyFileChange | null;
  sourceFilePath: string | null;
  checksum: string | null;
}

async function processOneNamespaceFile(
  filePath: string,
  fileSystem: FileSystem,
): Promise<FileNamespaceResult> {
  const originalContent = await fsp.readFile(filePath, 'utf-8');
  if (isGeneratedFile(originalContent)) {
    return {
      normalizedCount: -1,
      skippedCount: 0,
      change: null,
      undoChange: null,
      sourceFilePath: null,
      checksum: null,
    };
  }
  const sourceFile = await loadSourceFile(filePath, fileSystem);
  const fileChanges = normalizeNamespaceImportsInFile(sourceFile);
  if (fileChanges.length === 0) {
    return {
      normalizedCount: 0,
      skippedCount: countSkippedNamespaceImports(sourceFile),
      change: null,
      undoChange: null,
      sourceFilePath: null,
      checksum: null,
    };
  }
  const modifiedScriptContent = sourceFile.getFullText();
  const finalContent = filePath.endsWith('.vue')
    ? reinsertScript(originalContent, modifiedScriptContent)
    : modifiedScriptContent;
  if (finalContent === originalContent) {
    return {
      normalizedCount: 0,
      skippedCount: 0,
      change: null,
      undoChange: null,
      sourceFilePath: null,
      checksum: null,
    };
  }
  const fileChecksum = await computeFileChecksum(filePath);
  return {
    normalizedCount: fileChanges.length,
    skippedCount: 0,
    change: {
      type: 'modify-file',
      path: filePath,
      content: finalContent,
      originalChecksum: fileChecksum,
    },
    undoChange: {
      type: 'modify-file',
      path: filePath,
      content: originalContent,
      originalChecksum: computeStringChecksum(finalContent),
    },
    sourceFilePath: filePath,
    checksum: fileChecksum,
  };
}

/**
 * Propose normalizing namespace imports in a directory.
 *
 * @param writer - Callback for progress messages; tests can supply a stub to capture output
 */
export async function runNormalizeNamespaceImports(
  directoryArg: string,
  debugOptions: DebugOptions,
  fresh: boolean,
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

  const repoRoot = repoProvider.findRepositoryRoot(directory);
  const db = openStorage(debugOptions, {
    verbose: true,
    fresh,
    basePath: repoRoot,
    inMemory: isInMemory,
  });
  const allPaths = await repoProvider.getTypeScriptFilePaths(
    repoRoot,
    fileSystem,
  );

  const { indexImportFromFiles } = await import('./indexing');
  await indexImportFromFiles(allPaths, db, repoRoot, true, fileSystem, writer);
  db.save();

  const namespaceImportObjs = db.getSymbolImports('*');
  const filesWithNamespaceImports = new Set<string>();
  for (const obj of namespaceImportObjs) {
    const importerPath = obj.id.slice(
      'import|'.length,
      obj.id.lastIndexOf('|'),
    );
    if (isPathWithinDirectory(importerPath, directory)) {
      filesWithNamespaceImports.add(importerPath);
    }
  }

  if (filesWithNamespaceImports.size === 0) {
    writer('No namespace imports found in the codebase.\n');
    return createEmptyPlan('normalize-namespace-imports');
  }

  writer(
    `Found ${filesWithNamespaceImports.size} file(s) with namespace imports\n`,
  );

  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = [];
  const sourceFiles: string[] = [];
  const checksums: { [filePath: string]: string } = {};
  let totalNormalized = 0;
  let totalSkipped = 0;
  let skippedGenerated = 0;

  for (const filePath of filesWithNamespaceImports) {
    const result = await processOneNamespaceFile(filePath, fileSystem);
    if (result.normalizedCount === -1) {
      skippedGenerated++;
      continue;
    }
    totalSkipped += result.skippedCount;
    if (
      !result.change ||
      !result.undoChange ||
      !result.sourceFilePath ||
      !result.checksum
    ) {
      continue;
    }
    changes.push(result.change);
    undo.push(result.undoChange);
    sourceFiles.push(result.sourceFilePath);
    checksums[result.sourceFilePath] = result.checksum;
    totalNormalized += result.normalizedCount;
  }

  if (totalNormalized === 0) {
    writer('No namespace imports to normalize.\n');
    if (totalSkipped > 0) {
      writer(
        `Skipped ${totalSkipped} namespace import(s) that could not be safely normalized (name conflicts or non-member-access usage).\n`,
      );
    }
    return createEmptyPlan('normalize-namespace-imports');
  }

  writer(
    `Normalized ${totalNormalized} namespace import(s) across ${sourceFiles.length} file(s)\n`,
  );
  if (totalSkipped > 0) {
    writer(
      `Skipped ${totalSkipped} namespace import(s) that could not be safely normalized.\n`,
    );
  }
  if (skippedGenerated > 0) {
    writer(`Skipped ${skippedGenerated} @generated file(s)\n`);
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
  await displayPlan(plan, {}, cwd, writer);

  return plan;
}

function isNameNode(id: Node, parent: Node): boolean {
  /*
    Check whether `id` is the name (not a value reference) of a declaration
    or member that doesn't create a module-level binding. These identifiers
    are excluded from the collision set because they resolve within their
    containing scope rather than at the module level.
  */
  const isMemberDecl = (
    PropertyAssignment.isPropertyAssignment(parent) ||
    PropertySignature.isPropertySignature(parent) ||
    EnumMember.isEnumMember(parent) ||
    PropertyDeclaration.isPropertyDeclaration(parent) ||
    MethodDeclaration.isMethodDeclaration(parent) ||
    MethodSignature.isMethodSignature(parent) ||
    GetAccessorDeclaration.isGetAccessorDeclaration(parent) ||
    SetAccessorDeclaration.isSetAccessorDeclaration(parent)
  );
  return isMemberDecl && parent.getNameNode() === id;
}

function isExcludedIdentifier(id: Node): boolean {
  const parent = id.getParent();
  if (!parent) {
    return false;
  }

  // Property access names (right side of '.') resolve against the expression.
  if (
    PropertyAccessExpression.isPropertyAccessExpression(parent) &&
    parent.getNameNode() === id
  ) {
    return true;
  }

  // Qualified name right sides (X.Y) resolve against the left container.
  if (QualifiedName.isQualifiedName(parent) && parent.getRight() === id) {
    return true;
  }

  // Names of declarations/members that don't create module-level bindings
  if (isNameNode(id, parent)) {
    return true;
  }

  // Destructuring source keys (const { foo: bar } = obj) — foo is a property
  // name, not a binding. Only bar (getNameNode) creates a binding.
  if (
    BindingElement.isBindingElement(parent) &&
    parent.getPropertyNameNode() === id
  ) {
    return true;
  }

  // Function parameter names (function foo(bar)) — bar is scoped to the function.
  if (
    ParameterDeclaration.isParameterDeclaration(parent) &&
    parent.getNameNode() === id
  ) {
    return true;
  }

  return false;
}

function collectImportBindings(
  sourceFile: SourceFile,
  namespaceNames: Set<string>,
  bindings: Set<string>,
): void {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const nsImport = importDecl.getNamespaceImport();
    if (nsImport) {
      // Skip namespace imports being normalized — their binding will be
      // replaced by the new named imports. Non-normalized namespace imports
      // remain and must not collide.
      if (!namespaceNames.has(nsImport.getText())) {
        bindings.add(nsImport.getText());
      }
      continue;
    }
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
      bindings.add(defaultImport.getText());
    }
    for (const named of importDecl.getNamedImports()) {
      bindings.add(named.getName());
    }
  }
}

function collectExistingBindings(
  sourceFile: SourceFile,
  namespaceNames: Set<string>,
): Set<string> {
  const bindings = new Set<string>();

  /*
    Collect all names that would conflict with a new named import.
    Covers both module-level bindings and ambient references.
  */
  // Collect bindings from import declarations.
  collectImportBindings(sourceFile, namespaceNames, bindings);

  // Walk all identifiers (non-import) to capture binding names and ambient references.
  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) {
      continue;
    }
    if (isExcludedIdentifier(id)) {
      continue;
    }
    bindings.add(id.getText());
  }

  return bindings;
}

interface NamespaceUsageResult {
  memberAccessNodes: Array<{
    node: Node;
    memberName: string;
    isTypePosition: boolean;
  }>;
  namespaceUsedAsValue: boolean;
}

function tryGetPropertyAccessMember(
  id: Identifier,
  parent: Node | undefined,
): { node: Node; memberName: string; isTypePosition: false } | null {
  if (!PropertyAccessExpression.isPropertyAccessExpression(parent)) {
    return null;
  }
  if (parent.getExpression() !== id) {
    return null;
  }
  return { node: parent, memberName: parent.getName(), isTypePosition: false };
}

function tryGetQualifiedNameMember(
  id: Identifier,
  parent: Node | undefined,
): { node: Node; memberName: string; isTypePosition: true } | null {
  if (!QualifiedName.isQualifiedName(parent)) {
    return null;
  }
  if (parent.getLeft() !== id) {
    return null;
  }
  return {
    node: parent,
    memberName: parent.getRight().getText(),
    isTypePosition: true,
  };
}

function collectNamespaceUsages(
  sourceFile: SourceFile,
  importDecl: ImportDeclaration,
  nsName: string,
): NamespaceUsageResult {
  const memberAccessNodes: Array<{
    node: Node;
    memberName: string;
    isTypePosition: boolean;
  }> = [];
  let namespaceUsedAsValue = false;

  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== nsName) {
      continue;
    }
    if (
      id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === importDecl
    ) {
      continue;
    }
    const parent = id.getParent();
    /*
      Namespace identifiers that appear directly inside a computed property
      key ({ [NS]: value }) are runtime value uses. Unlike member accesses
      (NS.key) which can be replaced with named imports, a bare NS reference
      in a computed key would become a dangling reference after normalization.
      Mark as value use to block normalization.
    */
    if (parent && parent.getKind() === SyntaxKind.ComputedPropertyName) {
      namespaceUsedAsValue = true;
      continue;
    }
    const propAccess = tryGetPropertyAccessMember(id, parent);
    if (propAccess) {
      memberAccessNodes.push(propAccess);
      continue;
    }
    const qualifiedName = tryGetQualifiedNameMember(id, parent);
    if (qualifiedName) {
      memberAccessNodes.push(qualifiedName);
      continue;
    }
    namespaceUsedAsValue = true;
  }

  return { memberAccessNodes, namespaceUsedAsValue };
}

function applyNamespaceTransformation(
  importDecl: ImportDeclaration,
  memberAccessNodes: Array<{
    node: Node;
    memberName: string;
    isTypePosition: boolean;
  }>,
  accessedMembers: Set<string>,
  memberHasValueUse: Set<string>,
  moduleSpec: string,
  isTypeOnly: boolean,
): NamespaceNormalizationChange {
  const sortedAccesses = [...memberAccessNodes].sort(
    (a, b) => b.node.getStart() - a.node.getStart(),
  );
  for (const access of sortedAccesses) {
    access.node.replaceWithText(access.memberName);
  }
  const sortedMembers = [...accessedMembers].sort();
  if (isTypeOnly) {
    importDecl.replaceWithText(
      `import type { ${sortedMembers.join(', ')} } from '${moduleSpec}';`,
    );
  } else {
    const membersStr = sortedMembers
      .map((m) => (memberHasValueUse.has(m) ? m : `type ${m}`))
      .join(', ');
    importDecl.replaceWithText(
      `import { ${membersStr} } from '${moduleSpec}';`,
    );
  }
  return { moduleSpec, accessedMembers: sortedMembers };
}

function processNamespaceImport(
  sourceFile: SourceFile,
  importDecl: ImportDeclaration,
  nsName: string,
  moduleSpec: string,
  isTypeOnly: boolean,
  existingBindings: Set<string>,
): NamespaceNormalizationChange | null {
  const { memberAccessNodes, namespaceUsedAsValue } = collectNamespaceUsages(
    sourceFile,
    importDecl,
    nsName,
  );

  if (namespaceUsedAsValue || memberAccessNodes.length === 0) {
    return null;
  }

  const accessedMembers = new Set<string>();
  const memberHasValueUse = new Set<string>();
  for (const access of memberAccessNodes) {
    accessedMembers.add(access.memberName);
    if (!access.isTypePosition) {
      memberHasValueUse.add(access.memberName);
    }
  }

  for (const member of accessedMembers) {
    if (existingBindings.has(member)) {
      return null;
    }
  }

  return applyNamespaceTransformation(
    importDecl,
    memberAccessNodes,
    accessedMembers,
    memberHasValueUse,
    moduleSpec,
    isTypeOnly,
  );
}
