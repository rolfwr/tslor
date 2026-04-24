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
import { isGeneratedFile } from './generatedFileDetection';

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
  fileSystem: FileSystem
): Promise<FileNamespaceResult> {
  const originalContent = await fsp.readFile(filePath, 'utf-8');
  if (isGeneratedFile(originalContent)) {
    return { normalizedCount: -1, skippedCount: 0, change: null, undoChange: null, sourceFilePath: null, checksum: null };
  }
  const sourceFile = await loadSourceFile(filePath, fileSystem);
  const fileChanges = normalizeNamespaceImportsInFile(sourceFile);
  if (fileChanges.length === 0) {
    return { normalizedCount: 0, skippedCount: countSkippedNamespaceImports(sourceFile), change: null, undoChange: null, sourceFilePath: null, checksum: null };
  }
  const modifiedScriptContent = sourceFile.getFullText();
  const finalContent = filePath.endsWith('.vue') ? reinsertScript(originalContent, modifiedScriptContent) : modifiedScriptContent;
  if (finalContent === originalContent) {
    return { normalizedCount: 0, skippedCount: 0, change: null, undoChange: null, sourceFilePath: null, checksum: null };
  }
  const fileChecksum = await computeFileChecksum(filePath);
  return {
    normalizedCount: fileChanges.length,
    skippedCount: 0,
    change: { type: 'modify-file', path: filePath, content: finalContent, originalChecksum: fileChecksum },
    undoChange: { type: 'modify-file', path: filePath, content: originalContent, originalChecksum: computeStringChecksum(finalContent) },
    sourceFilePath: filePath,
    checksum: fileChecksum,
  };
}

export async function runNormalizeNamespaceImports(
  directoryArg: string,
  debugOptions: DebugOptions,
  repoProvider: RepositoryRootProvider,
  fileSystem: FileSystem,
): Promise<TslorPlan> {
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;
  const directory = normalizeAndValidatePath(directoryArg, "Directory", isInMemory);

  const repoRoot = repoProvider.findRepositoryRoot(directory);
  const db = openStorage(debugOptions, true);
  const allPaths = await repoProvider.getTypeScriptFilePaths(repoRoot, true);

  const { indexImportFromFiles } = await import('./indexing');
  await indexImportFromFiles(allPaths, db, repoRoot, true, fileSystem);
  db.save();

  const namespaceImportObjs = db.getSymbolImports('*');
  const filesWithNamespaceImports = new Set<string>();
  for (const obj of namespaceImportObjs) {
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
  let skippedGenerated = 0;

  for (const filePath of filesWithNamespaceImports) {
    const result = await processOneNamespaceFile(filePath, fileSystem);
    if (result.normalizedCount === -1) {
      skippedGenerated++;
      continue;
    }
    totalSkipped += result.skippedCount;
    if (!result.change || !result.undoChange || !result.sourceFilePath || !result.checksum) {
      continue;
    }
    changes.push(result.change);
    undo.push(result.undoChange);
    sourceFiles.push(result.sourceFilePath);
    checksums[result.sourceFilePath] = result.checksum;
    totalNormalized += result.normalizedCount;
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
  if (skippedGenerated > 0) {
    console.log(`Skipped ${skippedGenerated} @generated file(s)`);
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
  await displayPlan(plan, {});

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

function addNamed<T extends { getName(): string | undefined }>(bindings: Set<string>, nodes: T[]): void {
  for (const node of nodes) {
    const name = node.getName();
    if (name) {
      bindings.add(name);
    }
  }
}

function addImportBindings(
  bindings: Set<string>,
  importDecl: ImportDeclaration,
  namespaceNames: Set<string>
): void {
  const nsImport = importDecl.getNamespaceImport();
  if (nsImport && namespaceNames.has(nsImport.getText())) {
    return;
  }
  const defaultImport = importDecl.getDefaultImport();
  if (defaultImport) {
    bindings.add(defaultImport.getText());
  }
  for (const named of importDecl.getNamedImports()) {
    bindings.add(named.getName());
  }
}

function collectExistingBindings(sourceFile: SourceFile, namespaceNames: Set<string>): Set<string> {
  const bindings = new Set<string>();

  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    bindings.add(decl.getName());
  }
  for (const param of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
    bindings.add(param.getName());
  }
  addNamed(bindings, sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration));
  addNamed(bindings, sourceFile.getDescendantsOfKind(SyntaxKind.ClassDeclaration));
  for (const iface of sourceFile.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)) {
    bindings.add(iface.getName());
  }
  for (const typeAlias of sourceFile.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration)) {
    bindings.add(typeAlias.getName());
  }
  for (const enumDecl of sourceFile.getDescendantsOfKind(SyntaxKind.EnumDeclaration)) {
    bindings.add(enumDecl.getName());
  }

  for (const name of NODEJS_GLOBALS) {
    bindings.add(name);
  }

  for (const importDecl of sourceFile.getImportDeclarations()) {
    addImportBindings(bindings, importDecl, namespaceNames);
  }

  return bindings;
}

interface NamespaceUsageResult {
  memberAccessNodes: Array<{ node: Node; memberName: string; isTypePosition: boolean }>;
  namespaceUsedAsValue: boolean;
}

function tryGetPropertyAccessMember(
  id: ReturnType<SourceFile['getDescendantsOfKind']>[number],
  parent: Node | undefined
): { node: Node; memberName: string; isTypePosition: false } | null {
  if (!parent || parent.getKind() !== SyntaxKind.PropertyAccessExpression) {
    return null;
  }
  const propAccess = parent as PropertyAccessExpression;
  if (propAccess.getExpression() !== id) {
    return null;
  }
  return { node: propAccess, memberName: propAccess.getName(), isTypePosition: false };
}

function tryGetQualifiedNameMember(
  id: ReturnType<SourceFile['getDescendantsOfKind']>[number],
  parent: Node | undefined
): { node: Node; memberName: string; isTypePosition: true } | null {
  if (!parent || parent.getKind() !== SyntaxKind.QualifiedName) {
    return null;
  }
  const qualifiedName = parent as QualifiedName;
  if (qualifiedName.getLeft() !== id) {
    return null;
  }
  return { node: qualifiedName, memberName: qualifiedName.getRight().getText(), isTypePosition: true };
}

function collectNamespaceUsages(
  sourceFile: SourceFile,
  importDecl: ImportDeclaration,
  nsName: string
): NamespaceUsageResult {
  const memberAccessNodes: Array<{ node: Node; memberName: string; isTypePosition: boolean }> = [];
  let namespaceUsedAsValue = false;

  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== nsName) {
      continue;
    }
    if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === importDecl) {
      continue;
    }
    const parent = id.getParent();
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
  memberAccessNodes: Array<{ node: Node; memberName: string; isTypePosition: boolean }>,
  accessedMembers: Set<string>,
  memberHasValueUse: Set<string>,
  moduleSpec: string,
  isTypeOnly: boolean
): NamespaceNormalizationChange {
  const sortedAccesses = [...memberAccessNodes].sort((a, b) => b.node.getStart() - a.node.getStart());
  for (const access of sortedAccesses) {
    access.node.replaceWithText(access.memberName);
  }
  const sortedMembers = [...accessedMembers].sort();
  if (isTypeOnly) {
    importDecl.replaceWithText(`import type { ${sortedMembers.join(', ')} } from '${moduleSpec}';`);
  } else {
    const membersStr = sortedMembers
      .map(m => memberHasValueUse.has(m) ? m : `type ${m}`)
      .join(', ');
    importDecl.replaceWithText(`import { ${membersStr} } from '${moduleSpec}';`);
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
  const { memberAccessNodes, namespaceUsedAsValue } = collectNamespaceUsages(sourceFile, importDecl, nsName);

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

  return applyNamespaceTransformation(importDecl, memberAccessNodes, accessedMembers, memberHasValueUse, moduleSpec, isTypeOnly);
}
