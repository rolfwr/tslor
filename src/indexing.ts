/**
 * TSLOR indexing and import resolution.
 * 
 * This module implements the two-phase indexing process:
 * 1. Static AST analysis - Extract imports/exports without filesystem access
 * 2. Import resolution - Resolve module specifiers to absolute paths
 * 
 * The system uses static analysis only (no TypeScript semantic analysis)
 * for performance reasons. This trades some accuracy for dramatic speed
 * improvements on large codebases.
 */

import { Project, ProjectOptions, QuoteKind, SourceFile, SyntaxKind, ts, Node, ExportSpecifier,
  TypeReferenceNode, ExpressionWithTypeArguments, IndexedAccessTypeNode, MappedTypeNode,
  FunctionTypeNode, TypeLiteralNode, TypeQueryNode,
  FunctionDeclaration, InterfaceDeclaration, ClassDeclaration, MethodDeclaration, MethodSignature,
} from "ts-morph";
import { getTsconfigPathForFile, getTypeScriptFilePaths } from "./project";
import { dirname, relative, resolve } from "path";
import { CompilerOptions, modulePathSpec, modulePathToImportSpecAlias } from "./importSpec";
import { Storage } from "./storage";
import { TransformingFileSystem } from "./transformingFileSystem";
import { FileSystem, InMemoryFileSystem } from "./filesystem";
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { on } from 'node:events';

/**
 * Update the index with all TypeScript files in the repository.
 * 
 * This is the main entry point for building a complete index.
 */
export async function updateStorage(repoRoot: string, db: Storage, verbose: boolean, fileSystem: FileSystem, scopeDir?: string) {
  const paths: string[] = await getTypeScriptFilePaths(scopeDir ?? repoRoot, verbose);
  await indexImportFromFiles(paths, db, repoRoot, verbose, fileSystem);
}

/**
 * Index import/export information from a list of files.
 *
 * This performs incremental indexing - only files that have changed
 * since the last indexing run will be re-analyzed.
 *
 * For refactoring operations, this fails fast on any file processing error
 * to ensure atomicity across the entire codebase.
 */
export async function indexImportFromFiles(paths: string[], db: Storage, repoRoot: string, verbose: boolean, fileSystem: FileSystem) {
  if (fileSystem instanceof InMemoryFileSystem) {
    await indexImportFromFilesSequential(paths, db, repoRoot, verbose, fileSystem);
  } else {
    await indexImportFromFilesParallel(paths, db, repoRoot, verbose, fileSystem);
  }
}

async function indexImportFromFilesSequential(paths: string[], db: Storage, repoRoot: string, verbose: boolean, fileSystem: FileSystem) {
  let lastProgressAt = 0;
  for (let i = 0; i < paths.length; ++i) {
    const path = paths.at(i);
    if (path === undefined) {
      continue;
    }
    if (verbose) {
      const now = Date.now();
      if (now - lastProgressAt >= 100) {
        lastProgressAt = now;
        process.stdout.write('\rIndexing ' + (i + 1) + '/' + paths.length + '\x1b[K');
      }
    }
    await refreshImportsFromFile(db, path, repoRoot, fileSystem);
  }
  if (verbose) {
    process.stdout.write('\rIndexing ' + paths.length + '/' + paths.length + '\x1b[K');
    console.log();
  }
}

interface WorkerWrapper {
  send(path: string, repoRoot: string): void;
  terminate(): void;
  readonly worker: Worker;
}

type WorkerMessage =
  | { type: 'result'; moduleInfo: string }
  | { type: 'skip'; path: string; reason: string }
  | { type: 'error'; error: string };

function parseWorkerResult(msg: WorkerMessage): ModuleInfo | null {
  if (msg.type === 'error') {
    throw new Error(msg.error);
  }
  if (msg.type === 'skip') {
    return null;
  }
  const parsed: unknown = JSON.parse(msg.moduleInfo);
  if (!isModuleInfo(parsed)) {
    throw new Error('Worker returned invalid ModuleInfo');
  }
  return parsed;
}

function isModuleInfo(x: unknown): x is ModuleInfo {
  return typeof x === 'object' && x !== null && 'path' in x;
}

function isWorkerMessage(x: unknown): x is WorkerMessage {
  return typeof x === 'object' && x !== null && 'type' in x;
}

async function getWorkerFile(): Promise<URL> {
  if (!import.meta.url.endsWith('.ts')) {
    return new URL('./indexingWorker.mjs', import.meta.url);
  }
  /*
    In development (tsx mode), compile the worker to plain JS using esbuild.
    Write adjacent to node_modules so external packages resolve correctly.
  */
  const { build } = await import('esbuild');
  const { mkdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const srcDir = fileURLToPath(new URL('.', import.meta.url));
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const outDir = `${projectDir}/.tslor-worker-tmp`;
  const outFile = `${outDir}/indexingWorker.mjs`;
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [`${srcDir}indexingWorker.ts`],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['ts-morph', 'esbuild'],
  });
  return new URL(`file://${outFile}`);
}

function createWorkerWrapper(workerFile: URL): WorkerWrapper {
  const worker = new Worker(workerFile);
  return {
    worker,
    send(path: string, repoRoot: string): void {
      worker.postMessage({ type: 'index', path, repoRoot });
    },
    terminate(): void {
      void worker.terminate();
    },
  };
}

interface AsyncQueueWriter<T> {
  push(item: T): void;
  close(): void;
}

interface AsyncQueueReader<T> {
  take(): Promise<T | null>;
}

function createAsyncQueue<T>(): { writer: AsyncQueueWriter<T>; reader: AsyncQueueReader<T> } {
  const items: T[] = [];
  const waiters: Array<(item: T | null) => void> = [];
  let closed = false;

  const writer: AsyncQueueWriter<T> = {
    push(item: T): void {
      if (closed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter(item);
      } else {
        items.push(item);
      }
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      for (const waiter of waiters) {
        waiter(null);
      }
      waiters.length = 0;
    },
  };

  const reader: AsyncQueueReader<T> = {
    take(): Promise<T | null> {
      if (items.length > 0) {
        const item = items.shift();
        if (item === undefined) {
          throw new Error('Queue underflow');
        }
        return Promise.resolve(item);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise<T | null>(resolve => waiters.push(resolve));
    },
  };

  return { writer, reader };
}

async function indexImportFromFilesParallel(
  paths: string[],
  db: Storage,
  repoRoot: string,
  verbose: boolean,
  fileSystem: FileSystem,
): Promise<void> {
  let checkedCount = 0;
  let changedCount = 0;
  let processedCount = 0;
  let statDone = false;
  const abort = { value: false };

  const { writer, reader } = createAsyncQueue<{ path: string; mtimeMs: number }>();

  let lastProgressAt = 0;
  function printProgress(force: boolean): void {
    if (!verbose) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastProgressAt < 100) {
      return;
    }
    lastProgressAt = now;
    if (!statDone) {
      process.stdout.write(`\rChecking ${checkedCount}/${paths.length} | Indexing ${processedCount}\x1b[K`);
    } else if (changedCount > 0) {
      process.stdout.write(`\rIndexing ${processedCount}/${changedCount}\x1b[K`);
    } else {
      process.stdout.write(`\rChecked ${paths.length} files (no changes)\x1b[K`);
    }
  }

  // Run stat pass and worker file compilation concurrently
  const workerFilePromise = getWorkerFile();

  const statPromise = (async () => {
    for (const path of paths) {
      if (abort.value) {
        break;
      }
      const stats = await fileSystem.stat(path);
      const mtimeMs = stats.mtimeMs;
      checkedCount++;
      if (db.getFileTimestamp(path) !== mtimeMs) {
        changedCount++;
        writer.push({ path, mtimeMs });
      }
      printProgress(false);
    }
    statDone = true;
    writer.close();
  })();

  const workerFile = await workerFilePromise;
  const numWorkers = cpus().length;

  function makeFileProcessingError(filePath: string, error: unknown): Error {
    const msg = error instanceof Error ? error.message : String(error);
    return new Error(`Failed to process file ${filePath}: ${msg}`);
  }

  async function processWorkerMessage(
    msg: unknown,
    currentItem: { path: string; mtimeMs: number },
    nextItem: { path: string; mtimeMs: number } | null,
    wrapper: WorkerWrapper
  ): Promise<void> {
    if (nextItem) {
      wrapper.send(nextItem.path, repoRoot);
    }
    let moduleInfo: ModuleInfo | null;
    try {
      if (!isWorkerMessage(msg)) {
        throw new Error('Invalid worker message');
      }
      moduleInfo = parseWorkerResult(msg);
    } catch (error) {
      throw makeFileProcessingError(currentItem.path, error);
    }
    if (moduleInfo) {
      try {
        await storeImportsFromFile(moduleInfo, db, currentItem.mtimeMs, fileSystem);
      } catch (error) {
        throw makeFileProcessingError(currentItem.path, error);
      }
    }
    processedCount++;
    printProgress(false);
  }

  async function runWorker(wrapper: WorkerWrapper): Promise<void> {
    const first = await reader.take();
    if (!first) {
      wrapper.terminate();
      return;
    }
    wrapper.send(first.path, repoRoot);
    let currentItem = first;
    for await (const [msg] of on(wrapper.worker, 'message')) {
      const nextItem = await reader.take();
      await processWorkerMessage(msg, currentItem, nextItem, wrapper);
      if (!nextItem) {
        break;
      }
      currentItem = nextItem;
    }
    wrapper.terminate();
  }

  const firstError: { value: Error | null } = { value: null };

  async function runWorkerSafe(wrapper: WorkerWrapper): Promise<void> {
    try {
      await runWorker(wrapper);
    } catch (err) {
      if (!firstError.value) {
        firstError.value = err instanceof Error ? err : new Error(String(err));
      }
      wrapper.terminate();
      abort.value = true;
      writer.close();
    }
  }

  const workers = Array.from({ length: numWorkers }, () => createWorkerWrapper(workerFile));
  await Promise.all([statPromise, ...workers.map(runWorkerSafe)]);

  printProgress(true);
  if (verbose) {
    console.log();
  }

  if (firstError.value) {
    throw firstError.value;
  }
}

export interface ModuleInfo {
  path: string;
  repoRoot: string;
  tsconfig: string;
  importOfNamedExports: NamedExport[];
  importOfUnresolvedSpec: ExternalImport[];
  reExports: ReExport[];
  needs: {
    nodejs: boolean | Array<{ identifier: string; line: number; column: number }>;
  };
}

export interface ToolOptions {
  optimize: boolean;
  symbol: boolean;
}

async function refreshImportsFromFile(db: Storage, somePath: string, repoRoot: string, fileSystem: FileSystem) {
  try {
    const stats = await fileSystem.stat(somePath);
    const mtimeMs = stats.mtimeMs;

    const lastMtimeMs = db.getFileTimestamp(somePath);
    if (lastMtimeMs === mtimeMs) {
      return;
    }

    const moduleInfo = await inspectModule(repoRoot, somePath, fileSystem);
    if (!moduleInfo) {
      return; // no tsconfig — skip
    }
    await storeImportsFromFile(moduleInfo, db, mtimeMs, fileSystem);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to process file ${somePath}: ${errorMessage}`);
  }
}

interface ImplementationInfo {
  uses: UnresolvedExport[];
}

export interface StaticModuleInfo {
  imports: UnresolvedImports[];
  unresolvedExportsByImportNames: Map<string, UnresolvedExport>;
  exports: Map<string, ImplementationInfo>;
  identifierUses: Map<string, string[]>;
  exportedNames: Set<string>;
  reExports: ReExport[];
  usesNodejsGlobals: boolean;
  nodejsGlobalUsages?: Array<{ identifier: string; line: number; column: number }>;
}

export interface ImportUsage {
  symbol: string;
  usesImports: Array<{
    moduleSpec: string;
    importedName: string;
    isDefault: boolean;      // Whether this is a default import
    isTypeOnly: boolean;     // Whether this is a type-only import
  }>;

}

export async function inspectModule(repoRoot: string, tsFilePath: string, fileSystem: FileSystem): Promise<ModuleInfo | null> {
  try {
    const importerTsConfig = await getTsconfigPathForFile(repoRoot, tsFilePath, fileSystem);
    if (!importerTsConfig) {
      return null;
    }
    const sourceFile = await loadSourceFile(tsFilePath, fileSystem);

    const staticModuleInfo: StaticModuleInfo = parseModule(sourceFile);

  const moduleInfo: ModuleInfo = {
    path: tsFilePath,
    repoRoot,
    tsconfig: importerTsConfig,
    importOfNamedExports: [],
    importOfUnresolvedSpec: [],
    reExports: staticModuleInfo.reExports,
    needs: {
      nodejs: staticModuleInfo.nodejsGlobalUsages || staticModuleInfo.usesNodejsGlobals,
    },
  };

  const importSpecs = new Set<string>();

  for (const unresolved of staticModuleInfo.unresolvedExportsByImportNames.values()) {
    importSpecs.add(unresolved.moduleSpec);
  }

  const resolvedPathsBySpec = new Map<string, string>();
  for (const spec of importSpecs) {
    const resolvedPath = await resolveImportSpec(repoRoot, tsFilePath, spec, fileSystem);
    if (resolvedPath) {
      resolvedPathsBySpec.set(spec, resolvedPath);
    }
  }

  for (const unresolved of staticModuleInfo.unresolvedExportsByImportNames.values()) {
    const resolvedPath = resolvedPathsBySpec.get(unresolved.moduleSpec);
    if (resolvedPath) {
      moduleInfo.importOfNamedExports.push({
        type: 'NamedExport',
        path: resolvedPath,
        name: unresolved.name,
      });
    } else {
      moduleInfo.importOfUnresolvedSpec.push({
        type: 'ExternalImport',
        moduleSpecifier: unresolved.moduleSpec,
        name: unresolved.name,
      });
    }
  }

  return moduleInfo;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to inspect module ${tsFilePath}: ${errorMessage}`);
  }
}

/**
 * Creates a stateful module inspector that caches tsconfig path lookups (by directory)
 * and compiler options (by tsconfig path) across repeated calls. This eliminates the
 * redundant I/O that `resolveImportSpec` would otherwise perform on every import in
 * every file — the dominant overhead after TypeScript AST parsing itself.
 *
 * Intended for use in worker threads, where one inspector is created per worker.
 * Files are processed sequentially (never concurrently), so the caches are safe.
 */
export function createModuleInspector(fileSystem: FileSystem): (repoRoot: string, tsFilePath: string) => Promise<ModuleInfo> {
  const tsconfigPathByDir = new Map<string, string | null>();
  const compilerOptionsByTsconfig = new Map<string, CompilerOptions>();

  async function cachedGetTsconfigPath(repoRoot: string, filePath: string): Promise<string | null> {
    const dir = dirname(filePath);
    const cached = tsconfigPathByDir.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    const result = await getTsconfigPathForFile(repoRoot, filePath, fileSystem);
    tsconfigPathByDir.set(dir, result);
    return result;
  }

  async function cachedGetCompilerOptions(tsconfigFile: string): Promise<CompilerOptions> {
    const cached = compilerOptionsByTsconfig.get(tsconfigFile);
    if (cached !== undefined) {
      return cached;
    }
    const result = await getCompilerOptions(tsconfigFile, fileSystem);
    compilerOptionsByTsconfig.set(tsconfigFile, result);
    return result;
  }

  async function resolveSpecCached(repoRoot: string, tsFilePath: string, spec: string, tsconfigPath: string): Promise<string | null> {
    const compilerOptions = await cachedGetCompilerOptions(tsconfigPath);
    if (spec.startsWith('.')) {
      const resolvedPath = await resolveSourceFile(spec, dirname(tsFilePath), fileSystem);
      if (resolvedPath !== null) {
        return resolvedPath;
      }
    }
    return importSpecAliasToModulePath(compilerOptions, dirname(tsconfigPath), spec, fileSystem);
  }

  async function resolveSpecPaths(
    staticModuleInfo: StaticModuleInfo,
    repoRoot: string,
    tsFilePath: string,
    importerTsConfig: string
  ): Promise<Map<string, string>> {
    const importSpecs = new Set<string>();
    for (const unresolved of staticModuleInfo.unresolvedExportsByImportNames.values()) {
      importSpecs.add(unresolved.moduleSpec);
    }
    const resolvedPathsBySpec = new Map<string, string>();
    for (const spec of importSpecs) {
      const resolvedPath = await resolveSpecCached(repoRoot, tsFilePath, spec, importerTsConfig);
      if (resolvedPath) {
        resolvedPathsBySpec.set(spec, resolvedPath);
      }
    }
    return resolvedPathsBySpec;
  }

  function populateModuleInfoImports(
    moduleInfo: ModuleInfo,
    staticModuleInfo: StaticModuleInfo,
    resolvedPathsBySpec: Map<string, string>
  ): void {
    for (const unresolved of staticModuleInfo.unresolvedExportsByImportNames.values()) {
      const resolvedPath = resolvedPathsBySpec.get(unresolved.moduleSpec);
      if (resolvedPath) {
        moduleInfo.importOfNamedExports.push({
          type: 'NamedExport',
          path: resolvedPath,
          name: unresolved.name,
        });
      } else {
        moduleInfo.importOfUnresolvedSpec.push({
          type: 'ExternalImport',
          moduleSpecifier: unresolved.moduleSpec,
          name: unresolved.name,
        });
      }
    }
  }

  return async (repoRoot: string, tsFilePath: string): Promise<ModuleInfo> => {
    try {
      const importerTsConfig = await cachedGetTsconfigPath(repoRoot, tsFilePath);
      if (!importerTsConfig) {
        throw new Error('No tsconfig found');
      }

      const sourceFile = await loadSourceFile(tsFilePath, fileSystem);
      const staticModuleInfo: StaticModuleInfo = parseModule(sourceFile);

      const moduleInfo: ModuleInfo = {
        path: tsFilePath,
        repoRoot,
        tsconfig: importerTsConfig,
        importOfNamedExports: [],
        importOfUnresolvedSpec: [],
        reExports: staticModuleInfo.reExports,
        needs: {
          nodejs: staticModuleInfo.nodejsGlobalUsages || staticModuleInfo.usesNodejsGlobals,
        },
      };

      const resolvedPathsBySpec = await resolveSpecPaths(staticModuleInfo, repoRoot, tsFilePath, importerTsConfig);
      populateModuleInfoImports(moduleInfo, staticModuleInfo, resolvedPathsBySpec);

      return moduleInfo;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to inspect module ${tsFilePath}: ${errorMessage}`);
    }
  };
}

export interface NamedExport {
  type: 'NamedExport';
  path: string;
  name: string;
}

interface ExternalImport {
  type: 'ExternalImport';
  moduleSpecifier: string;
  name: string;
}

interface UnresolvedImports {
  moduleSpec: string;
  names: string[];
  typeOnly: boolean;
}

interface UnresolvedExport {
  name: string;
  moduleSpec: string;
}

interface ReExport {
  name: string;
  moduleSpec: string;
  isTypeOnly: boolean;
}

/**
 * Extract type references from an AST node using traversal that doesn't trigger filesystem access.
 * This finds TypeScript type dependencies within a single module.
 */
/**
 * Helper to add identifier uses to the static module info
 */
function addIdentifierUses(
  staticModuleInfo: StaticModuleInfo,
  symbolName: string,
  uses: string[]
): void {
  if (uses.length === 0) {
    return;
  }
  
  let usedIds = staticModuleInfo.identifierUses.get(symbolName);
  if (!usedIds) {
    usedIds = [];
    staticModuleInfo.identifierUses.set(symbolName, usedIds);
  }
  usedIds.push(...uses);
}

/**
 * Helper to track exported symbol and its type dependencies
 */
function trackExportedSymbol(
  staticModuleInfo: StaticModuleInfo,
  name: string,
  node: Node,
  isExported: boolean
): void {
  if (isExported) {
    staticModuleInfo.exportedNames.add(name);
  }
  
  const typeUses = extractTypeReferences(node);
  addIdentifierUses(staticModuleInfo, name, typeUses);
}

type TypeRefCallback = (name: string) => void;

function traverseTypeReferenceNode(typeNode: TypeReferenceNode, fn: TypeRefCallback): void {
  const typeName = typeNode.getTypeName();
  if (typeName.isKind(SyntaxKind.Identifier)) {
    fn(typeName.getText());
  }
  for (const typeArg of typeNode.getTypeArguments()) {
    traverseTypeNodeWith(typeArg, fn);
  }
}

function traverseExpressionWithTypeArgsNode(typeNode: ExpressionWithTypeArguments, fn: TypeRefCallback): void {
  const expression = typeNode.getExpression();
  if (expression.isKind(SyntaxKind.Identifier)) {
    fn(expression.getText());
  }
  for (const typeArg of typeNode.getTypeArguments()) {
    traverseTypeNodeWith(typeArg, fn);
  }
}

function traverseIndexedAccessNode(typeNode: IndexedAccessTypeNode, fn: TypeRefCallback): void {
  traverseTypeNodeWith(typeNode.getObjectTypeNode(), fn);
  traverseTypeNodeWith(typeNode.getIndexTypeNode(), fn);
}

function traverseMappedTypeNode(typeNode: MappedTypeNode, fn: TypeRefCallback): void {
  const typeParam = typeNode.getTypeParameter();
  const constraint = typeParam.getConstraint();
  if (constraint) {
    traverseTypeNodeWith(constraint, fn);
  }
  traverseTypeNodeWith(typeNode.getTypeNode(), fn);
}

function traverseFunctionTypeNode(typeNode: FunctionTypeNode, fn: TypeRefCallback): void {
  for (const param of typeNode.getParameters()) {
    traverseTypeNodeWith(param.getTypeNode(), fn);
  }
  traverseTypeNodeWith(typeNode.getReturnTypeNode(), fn);
}

function traverseTypeLiteralNode(typeNode: TypeLiteralNode, fn: TypeRefCallback): void {
  for (const member of typeNode.getMembers()) {
    if (member.isKind(SyntaxKind.PropertySignature)) {
      traverseTypeNodeWith(member.getTypeNode(), fn);
    }
  }
}

function traverseTypeQueryNode(typeNode: TypeQueryNode, fn: TypeRefCallback): void {
  const exprName = typeNode.getExprName();
  if (exprName.isKind(SyntaxKind.Identifier)) {
    fn(exprName.getText());
  }
}

function traverseTypeNodeWith(typeNode: Node | undefined, fn: TypeRefCallback): void {
  if (!typeNode) {
    return;
  }
  if (typeNode.isKind(SyntaxKind.TypeReference)) {
    traverseTypeReferenceNode(typeNode, fn);
    return;
  }
  if (typeNode.isKind(SyntaxKind.ExpressionWithTypeArguments)) {
    traverseExpressionWithTypeArgsNode(typeNode, fn);
    return;
  }
  if (typeNode.isKind(SyntaxKind.UnionType) || typeNode.isKind(SyntaxKind.IntersectionType)) {
    for (const type of typeNode.getTypeNodes()) {
      traverseTypeNodeWith(type, fn);
    }
    return;
  }
  if (typeNode.isKind(SyntaxKind.ParenthesizedType)) {
    traverseTypeNodeWith(typeNode.getTypeNode(), fn);
    return;
  }
  if (typeNode.isKind(SyntaxKind.ArrayType)) {
    traverseTypeNodeWith(typeNode.getElementTypeNode(), fn);
    return;
  }
  if (typeNode.isKind(SyntaxKind.IndexedAccessType)) {
    traverseIndexedAccessNode(typeNode, fn);
  }
  if (typeNode.isKind(SyntaxKind.TypeQuery)) {
    traverseTypeQueryNode(typeNode, fn);
  }
  if (typeNode.isKind(SyntaxKind.MappedType)) {
    traverseMappedTypeNode(typeNode, fn);
  }
  if (typeNode.isKind(SyntaxKind.FunctionType)) {
    traverseFunctionTypeNode(typeNode, fn);
  }
  if (typeNode.isKind(SyntaxKind.TypeLiteral)) {
    traverseTypeLiteralNode(typeNode, fn);
  }
}

function traverseParamsAndReturn(node: FunctionDeclaration | MethodDeclaration | MethodSignature, fn: TypeRefCallback): void {
  for (const param of node.getParameters()) {
    traverseTypeNodeWith(param.getTypeNode(), fn);
  }
  const returnTypeNode = node.getReturnTypeNode();
  traverseTypeNodeWith(returnTypeNode, fn);
}

function traverseHeritageClauses(node: InterfaceDeclaration | ClassDeclaration, fn: TypeRefCallback): void {
  for (const clause of node.getHeritageClauses()) {
    for (const type of clause.getTypeNodes()) {
      traverseTypeNodeWith(type, fn);
    }
  }
}

function traverseClassMethods(methods: Array<MethodDeclaration | MethodSignature>, fn: TypeRefCallback): void {
  for (const method of methods) {
    traverseParamsAndReturn(method, fn);
  }
}

function extractTypeRefsFromFunctionDecl(node: FunctionDeclaration, fn: TypeRefCallback): void {
  traverseParamsAndReturn(node, fn);
}

function extractTypeRefsFromInterfaceDecl(node: InterfaceDeclaration, fn: TypeRefCallback): void {
  traverseHeritageClauses(node, fn);
  for (const prop of node.getProperties()) {
    traverseTypeNodeWith(prop.getTypeNode(), fn);
  }
  traverseClassMethods(node.getMethods(), fn);
}

function extractTypeRefsFromClassDecl(node: ClassDeclaration, fn: TypeRefCallback): void {
  traverseHeritageClauses(node, fn);
  for (const prop of node.getProperties()) {
    const propTypeNode = prop.getTypeNode();
    if (propTypeNode) {
      traverseTypeNodeWith(propTypeNode, fn);
    }
  }
  for (const ctor of node.getConstructors()) {
    for (const param of ctor.getParameters()) {
      traverseTypeNodeWith(param.getTypeNode(), fn);
    }
  }
  traverseClassMethods(node.getMethods(), fn);
}

function extractTypeReferences(node: Node): string[] {
  const typeReferences: string[] = [];
  const visited = new Set<string>();
  const addTypeReference = (typeName: string) => {
    if (!visited.has(typeName)) {
      visited.add(typeName);
      typeReferences.push(typeName);
    }
  };
  if (node.isKind(SyntaxKind.FunctionDeclaration)) {
    extractTypeRefsFromFunctionDecl(node, addTypeReference);
  }
  if (node.isKind(SyntaxKind.VariableDeclaration)) {
    traverseTypeNodeWith(node.getTypeNode(), addTypeReference);
  }
  if (node.isKind(SyntaxKind.InterfaceDeclaration)) {
    extractTypeRefsFromInterfaceDecl(node, addTypeReference);
  }
  if (node.isKind(SyntaxKind.ClassDeclaration)) {
    extractTypeRefsFromClassDecl(node, addTypeReference);
  }
  if (node.isKind(SyntaxKind.TypeAliasDeclaration)) {
    traverseTypeNodeWith(node.getTypeNode(), addTypeReference);
  }
  return typeReferences;
}

/**
 * Derive import usage information from StaticModuleInfo.
 * This provides the same information as analyzeImportUsageBySymbol but works with StaticModuleInfo.
 */
type ImportMetadata = { isTypeOnly: boolean; isDefault: boolean };

function buildImportMetadata(moduleInfo: StaticModuleInfo): Map<string, ImportMetadata> {
  const importMetadata = new Map<string, ImportMetadata>();
  for (const imp of moduleInfo.imports) {
    for (const name of imp.names) {
      importMetadata.set(`${imp.moduleSpec}:${name}`, {
        isTypeOnly: imp.typeOnly,
        isDefault: name === 'default'
      });
    }
  }
  return importMetadata;
}

type UseImport = { moduleSpec: string; importedName: string; isDefault: boolean; isTypeOnly: boolean };

function resolveIdentifierImport(
  usedIdentifier: string,
  importMetadata: Map<string, ImportMetadata>,
  moduleInfo: StaticModuleInfo
): UseImport | null {
  const importInfo = moduleInfo.unresolvedExportsByImportNames.get(usedIdentifier);
  if (!importInfo) {
    return null;
  }
  const key = `${importInfo.moduleSpec}:${importInfo.name}`;
  const metadata = importMetadata.get(key);
  if (metadata) {
    return {
      moduleSpec: importInfo.moduleSpec,
      importedName: metadata.isDefault ? usedIdentifier : importInfo.name,
      isDefault: metadata.isDefault,
      isTypeOnly: metadata.isTypeOnly
    };
  }
  return {
    moduleSpec: importInfo.moduleSpec,
    importedName: importInfo.name,
    isDefault: false,
    isTypeOnly: false
  };
}

export function analyzeImportUsageFromStaticInfo(moduleInfo: StaticModuleInfo): ImportUsage[] {
  const result: ImportUsage[] = [];
  const importMetadata = buildImportMetadata(moduleInfo);
  
  for (const [symbolName, usedIdentifiers] of moduleInfo.identifierUses) {
    const usesImports: UseImport[] = [];
    
    for (const usedIdentifier of usedIdentifiers) {
      const imp = resolveIdentifierImport(usedIdentifier, importMetadata, moduleInfo);
      if (imp) {
        usesImports.push(imp);
      }
    }
    
    const uniqueImports = Array.from(new Map(
      usesImports.map(imp => [`${imp.moduleSpec}:${imp.importedName}:${imp.isDefault}:${imp.isTypeOnly}`, imp])
    ).values());
    
    if (usedIdentifiers.length > 0) {
      result.push({ symbol: symbolName, usesImports: uniqueImports });
    }
  }
  
  return result;
}

/**
 * Node.js-specific global identifiers that indicate the module requires Node.js runtime.
 * Excludes identifiers that are also available in modern browsers (e.g., console, setTimeout).
 */
export const NODEJS_GLOBALS = new Set([
  'Buffer',
  'process',
  '__dirname',
  '__filename',
  'global',
  'require',
  'module',
  'exports',
  '__esModule',
]);

/**
 * Checks if a Node.js global identifier is used in a type-only context.
 * This includes typeof expressions, type annotations, generic type parameters, etc.
 * Examples:
 * - `typeof process !== 'undefined'` - runtime typeof (TypeOfExpression)
 * - `x: typeof process` - type query (TypeQueryNode)
 * - `Promise<Buffer>` - type reference (TypeReferenceNode)
 * - `x: Buffer` - type annotation (TypeReferenceNode)
 */
function isInTypeContext(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;

  // Walk up the tree looking for type-only contexts
  while (current) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) {
      break;
    }

    // Check if this is a runtime typeof expression
    if (ts.isTypeOfExpression(parent)) {
      return true;
    }

    // Check if this is a TypeScript type query (typeof in type position)
    if (ts.isTypeQueryNode(parent)) {
      return true;
    }

    // Check if we're in a type reference (e.g., Promise<Buffer>, x: Buffer)
    if (ts.isTypeReferenceNode(parent)) {
      return true;
    }

    // Check if we're in a type annotation
    if (ts.isTypeNode(parent)) {
      return true;
    }

    current = parent;
  }

  return false;
}

/**
 * Checks if a node is within a conditional block guarded by a typeof check.
 * Example: code inside `if (typeof process !== 'undefined') { ... }`
 */
function isTypeofGuardCondition(condition: ts.Expression, globalName: string): boolean {
  if (!ts.isBinaryExpression(condition)) {
    return false;
  }
  const left = condition.left;
  if (!ts.isTypeOfExpression(left)) {
    return false;
  }
  const operand = left.expression;
  return ts.isIdentifier(operand) && operand.text === globalName;
}

function isWithinGuardedBlock(node: ts.Node, globalName: string): boolean {
  let current = node.parent;

  while (current) {
    if (ts.isIfStatement(current) && isTypeofGuardCondition(current.expression, globalName)) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

/**
 * Checks if an identifier is used as a binding name (parameter, variable, function/method name, etc.).
 * Examples:
 * - `function foo(require) {}` - parameter name
 * - `const process = ...` - variable name
 * - `function process() {}` - function name
 * - `get process()` - method name
 * - `interface { process(): void }` - method signature name
 * - `declare global {}` - module augmentation keyword
 */
function isBindingName(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  return (
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessor(parent) && parent.name === node) ||
    (ts.isSetAccessor(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isModuleDeclaration(parent) && parent.name === node)
  );
}

/**
 * Checks if an identifier is used as a property name rather than a global variable reference.
 * Examples:
 * - `window.global` - property access
 * - `{ process: string }` - property signature in interface/type
 * - `obj.exports = ...` - property assignment
 */
function isPropertyName(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  /*
    Check if this is the property name in a PropertyAccessExpression.
    e.g., in `window.global`, `global` is the property name.
  */
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }

  /*
    Check if this is a property signature in an interface/type.
    e.g., in `interface Foo { process: string }`, `process` is the property name.
  */
  if (ts.isPropertySignature(parent) && parent.name === node) {
    return true;
  }

  /*
    Check if this is a property declaration in a class.
    e.g., in `class Foo { process: string }`, `process` is the property name.
  */
  if (ts.isPropertyDeclaration(parent) && parent.name === node) {
    return true;
  }

  /*
    Check if this is a property assignment in an object literal.
    e.g., in `{ process: value }`, `process` is the property name.
  */
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return true;
  }

  return false;
}

/**
 * Detects if a source file uses Node.js-specific global identifiers without proper guards.
 * Ignores usage within:
 * 1. Binding names (e.g., parameters, variables, function/method names)
 * 2. Property names (e.g., `window.global`, `{ process: string }`)
 * 3. Type-only contexts (e.g., `Promise<Buffer>`, `x: Buffer`, `typeof process`)
 * 4. Conditional blocks guarded by typeof checks (code inside if blocks)
 *
 * Returns both a boolean and details about detected usages for debugging.
 */
function processNodeForGlobals(
  node: import('ts-morph').Node,
  sourceFile: SourceFile,
  usages: Array<{ identifier: string; line: number; column: number }>
): void {
  if (node.getKind() !== SyntaxKind.Identifier) {
    return;
  }
  const identifierText = node.getText();
  if (!NODEJS_GLOBALS.has(identifierText)) {
    return;
  }
  const compilerNode = node.compilerNode;
  if (isBindingName(compilerNode)) {
    return;
  }
  if (isPropertyName(compilerNode)) {
    return;
  }
  if (isInTypeContext(compilerNode)) {
    return;
  }
  if (isWithinGuardedBlock(compilerNode, identifierText)) {
    return;
  }
  const pos = sourceFile.compilerNode.getLineAndCharacterOfPosition(compilerNode.getStart());
  usages.push({
    identifier: identifierText,
    line: pos.line + 1,
    column: pos.character + 1,
  });
}

function detectNodejsGlobals(sourceFile: SourceFile): {
  usesNodejsGlobals: boolean;
  usages: Array<{ identifier: string; line: number; column: number }>;
} {
  const usages: Array<{ identifier: string; line: number; column: number }> = [];

  sourceFile.forEachDescendant((node) => {
    processNodeForGlobals(node, sourceFile, usages);
  });

  return {
    usesNodejsGlobals: usages.length > 0,
    usages,
  };
}

/**
 * Collect identifier references from a node, skipping property names in property access expressions
 */
function collectIdentifierReferences(node: Node): string[] {
  const identifiers: Node[] = node.isKind(SyntaxKind.Identifier)
    ? [node]
    : node.getDescendantsOfKind(SyntaxKind.Identifier);
  
  const references: string[] = [];
  for (const id of identifiers) {
    const usedName = id.getText();
    
    // Skip identifiers that are property/method names in property access expressions
    const parent = id.getParent();
    if (parent && parent.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propertyAccess = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      // Skip if this identifier is the property name (right side of the dot)
      if (propertyAccess.getName() === usedName) {
        continue;
      }
    }

    /*
      Skip property names in object literal assignments (non-shorthand)
      e.g., in `{ description: 'value' }`, skip `description`
      Note: shorthand `{ myVar }` uses ShorthandPropertyAssignment, not PropertyAssignment
    */
    if (parent && parent.getKind() === SyntaxKind.PropertyAssignment) {
      const propAssignment = parent.asKindOrThrow(SyntaxKind.PropertyAssignment);
      if (propAssignment.getNameNode() === id) {
        continue;
      }
    }

    references.push(usedName);
  }

  return references;
}

/**
 * Collect local names (parameters and local variables) from a function
 */
function collectLocalNames(funcDecl: FunctionDeclaration): Set<string> {
  const localNames = new Set<string>();
  
  // Add parameter names
  const parameters = funcDecl.getParameters();
  for (const param of parameters) {
    localNames.add(param.getName());
  }
  
  // Add local variable names (const, let, var declarations within function)
  const body = funcDecl.getBody();
  if (body) {
    const variableDeclarations = body.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    for (const varDecl of variableDeclarations) {
      localNames.add(varDecl.getName());
    }
  }
  
  return localNames;
}

/**
 * Parse import declaration
 */
function parseImportDeclaration(
  node: Node,
  staticModuleInfo: StaticModuleInfo
): void {
  const idecl = node.asKind(SyntaxKind.ImportDeclaration);
  if (!idecl) {
    return;
  }
  
  const importClause = idecl.getImportClause();
  if (!importClause) {
    return;
  }
  
  const names: string[] = [];
  const isTypeOnly = importClause.isTypeOnly();
  
  const moduleSpecifier = node.getFirstChildByKind(SyntaxKind.StringLiteral);
  if (!moduleSpecifier) {
    throw new Error('No module specifier found');
  }
  const moduleSpec = moduleSpecifier.getLiteralText();
  
  const namedBindings = importClause.getFirstChildByKind(SyntaxKind.NamedImports);

  if (namedBindings) {
    namedBindings.forEachChild((child: Node) => {
      const name = child.getFirstChildByKind(SyntaxKind.Identifier);
      if (!name) {
        throw new Error('No name found');
      }

      /*
        NOTE: Import aliases (import { foo as bar }) are intentionally not supported.
        These will be handled by a separate `tslor normalize-imports` command.
      */
      const importName = name.getText();
      const exportName = name.getText();

      names.push(exportName);

      staticModuleInfo.unresolvedExportsByImportNames.set(importName, { name: exportName, moduleSpec });
    });
  } else {
    const namespaceImport = importClause.getFirstChildByKind(SyntaxKind.NamespaceImport);
    if (namespaceImport) {
      const nsName = namespaceImport.getName();
      names.push('*');
      staticModuleInfo.unresolvedExportsByImportNames.set(nsName, { name: '*', moduleSpec });
    } else {
      const defaultBinding = importClause.getFirstChildByKind(SyntaxKind.Identifier);
      if (defaultBinding) {
        names.push('default');
        staticModuleInfo.unresolvedExportsByImportNames.set(defaultBinding.getText(), { name: 'default', moduleSpec });
      }
    }
  }

  if (names.length > 0) {
    staticModuleInfo.imports.push({
      moduleSpec,
      names,
      typeOnly: isTypeOnly,
    });
  }
}

/**
 * Parse variable statement
 */
function parseVariableStatement(
  node: Node,
  staticModuleInfo: StaticModuleInfo
): void {
  const varStatement = node.asKind(SyntaxKind.VariableStatement);
  if (!varStatement) {
    return;
  }

  /*
    We should not call varStatement.isExported(), since that causes file
    system access, trying to check for a "package.json" file and trying to
    read "node_modules/typescript/lib/lib.d.ts".
  */
  const varExported = varStatement.hasModifier(SyntaxKind.ExportKeyword);

  if (varExported) {
    const decls = varStatement.getDeclarations();
    for (const decl of decls) {
      const name = decl.getName();
      staticModuleInfo.exportedNames.add(name);
    }
  }

  // Track type dependencies in variable declarations
  const decls = varStatement.getDeclarations();
  for (const decl of decls) {
    const name = decl.getName();
    
    // Track type dependencies
    const typeUses = extractTypeReferences(decl);
    addIdentifierUses(staticModuleInfo, name, typeUses);
    
    // Track value dependencies from initializer
    const initializer = decl.getInitializer();
    if (initializer) {
      const valueUses = collectIdentifierReferences(initializer);
      addIdentifierUses(staticModuleInfo, name, valueUses);
    }
  }
}

/**
 * Parse function declaration
 */
function parseFunctionDeclaration(
  node: Node,
  staticModuleInfo: StaticModuleInfo
): void {
  const funcDecl = node.asKind(SyntaxKind.FunctionDeclaration);
  if (!funcDecl) {
    return;
  }
  
  /*
    We should not use funcDecl.isNamedExport() here, since that causes file
    system access, trying to check if the file specified by the module
    specifier exists on disk in some form.

    Likewise calling funcDecl.isExported() can also cause file system
    access.

    Therefore we instead look for the export keyword in the source code.
  */
  const exported = funcDecl.hasModifier(SyntaxKind.ExportKeyword);

  const name = funcDecl.getName();
  if (!name) {
    throw new Error('Do not know how to deal with named export without name');
  }
  
  const body = funcDecl.getBody();

  /*
    When a function has multiple type signatures, then only one of the type
    signatures will have a body.
  */

  if (body) {
    const localNames = collectLocalNames(funcDecl);
    const allRefs = collectIdentifierReferences(body);
    const valueUses = allRefs.filter(name => !localNames.has(name));

    addIdentifierUses(staticModuleInfo, name, valueUses);

    if (exported) {
      staticModuleInfo.exportedNames.add(name);
    }
    
    const typeUses = extractTypeReferences(funcDecl);
    addIdentifierUses(staticModuleInfo, name, typeUses);
  }
}

/**
 * Parse interface declaration
 */
function parseInterfaceDeclaration(
  node: Node,
  staticModuleInfo: StaticModuleInfo
): void {
  const interfaceDecl = node.asKind(SyntaxKind.InterfaceDeclaration);
  if (!interfaceDecl) {
    return;
  }
  
  const exported = interfaceDecl.hasModifier(SyntaxKind.ExportKeyword);
  const name = interfaceDecl.getName();
  
  trackExportedSymbol(staticModuleInfo, name, interfaceDecl, exported);
}

/**
 * Parse type alias declaration
 */
function parseTypeAliasDeclaration(
  node: Node,
  staticModuleInfo: StaticModuleInfo
): void {
  const typeAliasDecl = node.asKind(SyntaxKind.TypeAliasDeclaration);
  if (!typeAliasDecl) {
    return;
  }
  
  const exported = typeAliasDecl.hasModifier(SyntaxKind.ExportKeyword);
  const name = typeAliasDecl.getName();
  
  trackExportedSymbol(staticModuleInfo, name, typeAliasDecl, exported);
}

/**
 * Parse class declaration
 */
function parseClassDeclaration(
  node: Node,
  staticModuleInfo: StaticModuleInfo
): void {
  const classDecl = node.asKind(SyntaxKind.ClassDeclaration);
  if (!classDecl) {
    return;
  }

  const exported = classDecl.hasModifier(SyntaxKind.ExportKeyword);
  const name = classDecl.getName();

  if (name) {
    trackExportedSymbol(staticModuleInfo, name, classDecl, exported);
  }
}

/**
 * Parse export declaration (re-exports)
 */
function parseExportDeclaration(
  node: Node,
  staticModuleInfo: StaticModuleInfo
): void {
  const exportDecl = node.asKind(SyntaxKind.ExportDeclaration);
  if (!exportDecl) {
    return;
  }

  const moduleSpecifier = exportDecl.getModuleSpecifier();
  if (!moduleSpecifier) {
    return; // Not a re-export
  }

  const moduleSpec = moduleSpecifier.getLiteralText();
  const isTypeOnly = exportDecl.isTypeOnly();

  // Handle named exports
  const namedExports = exportDecl.getNamedExports();
  if (namedExports) {
    namedExports.forEach((namedExport: ExportSpecifier) => {
      const name = namedExport.getName();
      staticModuleInfo.reExports.push({
        name,
        moduleSpec,
        isTypeOnly
      });
      // Also mark as exported from this module
      staticModuleInfo.exportedNames.add(name);
    });
  } else {
    /*
      Handle namespace re-exports (export * from 'module').
      For now, we'll skip these as they're less common and harder to handle.
      TODO: Add support for namespace re-exports if needed.
    */
  }
}

export function parseModule(sourceFile: SourceFile): StaticModuleInfo {
  const staticModuleInfo: StaticModuleInfo = {
    imports: [],
    unresolvedExportsByImportNames: new Map<string, UnresolvedExport>(),
    exports: new Map<string, ImplementationInfo>(),
    identifierUses: new Map<string, string[]>(),
    exportedNames: new Set<string>(),
    reExports: [],
    usesNodejsGlobals: false,
  };

  sourceFile.forEachChild((node) => {
    parseImportDeclaration(node, staticModuleInfo);
    parseVariableStatement(node, staticModuleInfo);
    parseFunctionDeclaration(node, staticModuleInfo);
    parseInterfaceDeclaration(node, staticModuleInfo);
    parseTypeAliasDeclaration(node, staticModuleInfo);
    parseClassDeclaration(node, staticModuleInfo);
    parseExportDeclaration(node, staticModuleInfo);
  });

  const usedExportsByName = new Map<string, Set<UnresolvedExport>>();

  const newExports = new Map<string, ImplementationInfo>();
  for (const name of staticModuleInfo.exportedNames) {
    const uses = calculateAccumulatedExports(staticModuleInfo, usedExportsByName, name);
    newExports.set(name, { uses: Array.from(uses) });
  }

  staticModuleInfo.exports = newExports;

  // Detect Node.js global usage
  const nodejsDetection = detectNodejsGlobals(sourceFile);
  staticModuleInfo.usesNodejsGlobals = nodejsDetection.usesNodejsGlobals;
  if (nodejsDetection.usages.length > 0) {
    staticModuleInfo.nodejsGlobalUsages = nodejsDetection.usages;
  }

  return staticModuleInfo;
}

function calculateAccumulatedExports(staticModuleInfo: StaticModuleInfo, usedExportsByName: Map<string, Set<UnresolvedExport>>, name: string): Set<UnresolvedExport> {
  const seen = usedExportsByName.get(name);
  if (seen) {
    return seen;
  }

  const result = new Set<UnresolvedExport>();
  usedExportsByName.set(name, result);
  const used = staticModuleInfo.identifierUses.get(name);
  if (!used) {
    return result;
  }

  for (const usedName of used) {
    const exports = staticModuleInfo.unresolvedExportsByImportNames.get(usedName);
    if (exports) {
      result.add(exports);
      continue;
    }

    const subResult = calculateAccumulatedExports(staticModuleInfo, usedExportsByName, usedName);
    for (const subExport of subResult) {
      result.add(subExport);
    }
  }

  return result;
}



async function storeImportsFromFile(moduleInfo: ModuleInfo, db: Storage, mtimeMs: number, fileSystem: FileSystem) {
  db.deleteImporterPath(moduleInfo.path);

  let pos = 0;
  for (const imp of moduleInfo.importOfNamedExports)
  {
    const exporterTsConfig = await getTsconfigPathForFile(moduleInfo.repoRoot, imp.path, fileSystem);
    if (!exporterTsConfig) {
      throw new Error('No tsconfig found');
    }
    db.putImport(moduleInfo.path, moduleInfo.tsconfig, pos++, imp.name, { path: imp.path, tsconfig: exporterTsConfig });
  }

  for (const imp of moduleInfo.importOfUnresolvedSpec)
  {
    db.putImport(moduleInfo.path, moduleInfo.tsconfig, pos++, imp.name, { spec: imp.moduleSpecifier });
  }

  // Store re-exports
  for (let i = 0; i < moduleInfo.reExports.length; i++) {
    const reExport = moduleInfo.reExports.at(i);
    if (reExport === undefined) {
      continue;
    }
    db.putReExport(moduleInfo.path, i, reExport.name, {
      moduleSpec: reExport.moduleSpec,
      isTypeOnly: reExport.isTypeOnly
    });
  }

  // Convert needs to boolean for storage (array means true)
  const needsBoolean = {
    nodejs: Array.isArray(moduleInfo.needs.nodejs) ? moduleInfo.needs.nodejs.length > 0 : moduleInfo.needs.nodejs
  };
  db.putModuleNeeds(moduleInfo.path, needsBoolean);
  db.addFileTimestamp(moduleInfo.path, mtimeMs);
}



export async function loadSourceFile(srcPath: string, fileSystem: FileSystem, fileContents?: Map<string, string>) {
  // Determine if we're using in-memory filesystem based on the filesystem type
  const isInMemory = fileSystem instanceof InMemoryFileSystem;

  const project = isInMemory ? new Project(inMemoryProjectOptions(fileContents ?? new Map())) : createProject();

  if (!isInMemory) {
    // Verify that the source file exists first using the filesystem abstraction
    try {
      const stat = await fileSystem.stat(srcPath);
      if (!stat.isFile()) {
        throw new Error('Not a file: ' + srcPath);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('ENOENT')) {
        throw new Error('Not found: ' + srcPath);
      }
      throw err;
    }

    project.addSourceFileAtPath(srcPath);
  } else {
    /*
      For in-memory, create the source file with content.
      If fileContents was not provided, read from the InMemoryFileSystem.
    */
    const content = fileContents?.get(srcPath) ?? await fileSystem.readFile(srcPath);
    project.createSourceFile(srcPath, content);
  }

  const sourceFile = project.getSourceFile(srcPath);
  if (!sourceFile) {
    throw new Error('Source file not found');
  }
  return sourceFile;
}

function createProject() {
  return new Project(defaultProjectOptions());
}

export function defaultProjectOptions(): ProjectOptions {
  return {
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Single
    },
    fileSystem: new TransformingFileSystem(),
  };
}

export function inMemoryProjectOptions(fileContents: Map<string, string>): ProjectOptions {
  return {
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Single
    },
    fileSystem: {
      isCaseSensitive: () => true,
      delete: () => Promise.reject(new Error("delete not implemented")),
      deleteSync: () => { throw new Error("deleteSync not implemented"); },
      readDirSync: () => [],
      readFile: async (filePath: string) => fileContents.get(filePath) || '',
      readFileSync: (filePath: string) => fileContents.get(filePath) || '',
      writeFile: () => Promise.reject(new Error("writeFile not implemented")),
      writeFileSync: () => { throw new Error("writeFileSync not implemented"); },
      mkdir: () => Promise.reject(new Error("mkdir not implemented")),
      mkdirSync: () => { throw new Error("mkdirSync not implemented"); },
      move: () => Promise.reject(new Error("move not implemented")),
      moveSync: () => { throw new Error("moveSync not implemented"); },
      copy: () => Promise.reject(new Error("copy not implemented")),
      copySync: () => { throw new Error("copySync not implemented"); },
      fileExists: async (filePath: string) => Promise.resolve(fileContents.has(filePath)),
      fileExistsSync: (filePath: string) => fileContents.has(filePath),
      directoryExists: () => Promise.resolve(false),
      directoryExistsSync: () => false,
      getCurrentDirectory: () => '/',
      glob: () => Promise.resolve([]),
      globSync: () => [],
      realpathSync: (path: string) => path,
    },
  };
}

export async function resolveImportSpec(repoRoot: string, tsFilePath: string, importSpec: string, fileSystem: FileSystem) {
  const tsconfigPath = await getTsconfigPathForFile(repoRoot, tsFilePath, fileSystem);
  if (!tsconfigPath) {
    throw new Error('No tsconfig found');
  }

  const compilerOptions = await getCompilerOptions(tsconfigPath, fileSystem);

  let resolvedPath: string | null = null;
  if (importSpec.startsWith('.')) {
    resolvedPath = await resolveSourceFile(importSpec, dirname(tsFilePath), fileSystem);
  }

  if (resolvedPath === null) {
    resolvedPath = await importSpecAliasToModulePath(compilerOptions, dirname(tsconfigPath), importSpec, fileSystem);
  }
  return resolvedPath;
}

export async function getCompilerOptions(tsconfigFile: string, fileSystem: FileSystem): Promise<CompilerOptions> {
  const tsconfigContent = await fileSystem.readFile(tsconfigFile);
  const tsconfig = ts.parseConfigFileTextToJson(tsconfigFile, tsconfigContent);
  if (tsconfig.error) {
    throw new Error('Failed to read tsconfig');
  }
  const paths = tsconfig.config.compilerOptions?.paths ?? {}

  const baseUrl = tsconfig.config.compilerOptions?.baseUrl || null;
  const rootDir = tsconfig.config.compilerOptions?.rootDir || null;

  return {
    paths,
    baseUrl,
    rootDir,
  };
}

async function resolveSourceFile(spec: string, baseDir: string, fileSystem: FileSystem) {
  const absSpec = resolve(baseDir, spec);

  let isDir = false;
  const parentDir = dirname(absSpec);
  try {
    const stat = await fileSystem.stat(parentDir);
    if (stat.isFile()) { // Parent should be a directory, not a file
      return null;
    }
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('ENOENT')) {
      throw err;
    }
    return null;
  }

  try {
    const stat = await fileSystem.stat(absSpec);
    isDir = !stat.isFile(); // If it's not a file, assume it's a directory
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('ENOENT')) {
      throw err;
    }
  }

  if (isDir) {
    return absSpec + '/index.ts';
  }
  // Handle .js/.mjs → .ts/.mts extension mapping (standard in TypeScript ESM projects)
  if (absSpec.endsWith('.js')) {
    return absSpec.slice(0, -3) + '.ts';
  }
  if (absSpec.endsWith('.mjs')) {
    return absSpec.slice(0, -4) + '.mts';
  }
  return absSpec + '.ts';
}

async function resolvePathWithBaseUrl(
  relPath: string,
  tsconfigDir: string,
  baseUrl: string | null | undefined,
  fileSystem: FileSystem
): Promise<string | null> {
  const sourcePath = await resolveSourceFile(relPath, tsconfigDir, fileSystem);
  if (sourcePath) {
    return sourcePath;
  }
  if (baseUrl) {
    const baseDir = resolve(tsconfigDir, baseUrl);
    return await resolveSourceFile(relPath, baseDir, fileSystem) ?? null;
  }
  return null;
}

async function importSpecAliasToModulePath(compilerOptions: CompilerOptions, tsconfigDir: string, importSpec: string, fileSystem: FileSystem) {
  for (const [alias, paths] of Object.entries(compilerOptions.paths)) {
    if (!alias.endsWith('/*')) {
      throw new Error('Unspported alias');
    }
    const aliasPrefix = alias.slice(0, -1);
    if (!importSpec.startsWith(aliasPrefix)) {
      continue;
    }
    if (paths.length !== 1) {
      throw new Error('Unsupported alias path count');
    }
    for (const path of paths) {
      if (!path.endsWith('/*')) {
        throw new Error('Unsupported alias path');
      }
      const pathPrefix = path.slice(0, -1);
      const relPath = pathPrefix + importSpec.slice(aliasPrefix.length);
      const sourcePath = await resolvePathWithBaseUrl(relPath, tsconfigDir, compilerOptions.baseUrl, fileSystem);
      if (sourcePath) {
        return sourcePath;
      }
    }
  }
  return null;
}

export async function resolveImportSpecAlias(repoRoot: string, tsFilePath: string, modulePath: string, fileSystem: FileSystem) {
  const tsconfigPath = await getTsconfigPathForFile(repoRoot, tsFilePath, fileSystem);
  if (!tsconfigPath) {
    throw new Error('No tsconfig found');
  }

  const tsconfigDir = dirname(tsconfigPath);

  const compilerOptions = await getCompilerOptions(tsconfigPath, fileSystem);
  let importSpec = modulePathToImportSpecAlias(compilerOptions, tsconfigDir, modulePath);
  if (!importSpec) {
    const dirPrefix = tsconfigDir + '/';
    if (modulePath.startsWith(dirPrefix) && tsFilePath.startsWith(dirPrefix)) {
      const relPath = relative(dirname(tsFilePath), modulePathSpec(modulePath));
      if (relPath.startsWith('.')) {
        importSpec = relPath;
      } else {
        importSpec = './' + relPath;
      }
    }
  }
  return importSpec;
}
