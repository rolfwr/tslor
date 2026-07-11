import { inspectModule } from './inspectModule';
import type { ModuleInfo } from './inspectModule';
import { getTsconfigPathForFile, getTypeScriptFilePaths } from './project';
import { Storage } from './storage';
import { FileSystem, InMemoryFileSystem } from './filesystem';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { on } from 'node:events';
import { CliError, reThrowAsCliError } from './errors';

/**
 * Update the index with all TypeScript files in the repository.
 *
 * This is the main entry point for building a complete index.
 *
 * @param verbose - When true, progress messages are written via the writer callback
 * @param scopeDir - Directory to scope indexing to; defaults to repoRoot
 */
export async function updateStorage(
  repoRoot: string,
  db: Storage,
  verbose: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
  options: { scopeDir?: string },
) {
  const paths: string[] = await getTypeScriptFilePaths(
    options?.scopeDir ?? repoRoot,
    fileSystem,
  );
  if (verbose) {
    writer('Found ' + paths.length + ' TypeScript files.');
  }
  await indexImportFromFiles(paths, db, repoRoot, verbose, fileSystem, writer);
}

/**
 * Index import/export information from a list of files.
 *
 * This performs incremental indexing - only files that have changed
 * since the last indexing run will be re-analyzed.
 *
 * For refactoring operations, this fails fast on any file processing error
 * to ensure atomicity across the entire codebase.
 *
 * @param writer - Callback for progress messages
 */
export async function indexImportFromFiles(
  paths: string[],
  db: Storage,
  repoRoot: string,
  verbose: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  if (fileSystem instanceof InMemoryFileSystem) {
    await indexImportFromFilesSequential(
      paths,
      db,
      repoRoot,
      verbose,
      fileSystem,
      writer,
    );
  } else {
    await indexImportFromFilesParallel(
      paths,
      db,
      repoRoot,
      verbose,
      fileSystem,
      writer,
    );
  }
}

async function indexImportFromFilesSequential(
  paths: string[],
  db: Storage,
  repoRoot: string,
  verbose: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  let lastProgressAt = 0;
  for (const [i, path] of paths.entries()) {
    if (verbose) {
      const now = Date.now();
      if (now - lastProgressAt >= 100) {
        lastProgressAt = now;
        writer('\rIndexing ' + (i + 1) + '/' + paths.length + '\x1b[K');
      }
    }
    await refreshImportsFromFile(db, path, repoRoot, fileSystem);
  }
  if (verbose) {
    writer('\rIndexing ' + paths.length + '/' + paths.length + '\x1b[K');
    writer('\n');
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

/*
  Deserialize a worker message. The msg parameter is typed unknown
  because it comes from the Node.js events API which doesn't constrain
  message types. We validate the shape before narrowing.
*/
function parseWorkerResult(msg: unknown): ModuleInfo | null {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
    throw new Error('Worker message is not a valid object');
  }
  // RATIONALE: validated shape above; Worker postMessage always produces plain objects matching WorkerMessage
  // ast-grep-ignore: no-type-assertion
  const workerMsg = msg as WorkerMessage;
  const msgType = workerMsg.type;
  if (msgType === 'error') {
    throw new Error(workerMsg.error);
  }
  if (msgType === 'skip') {
    return null;
  }
  if (msgType !== 'result') {
    throw new Error('Unexpected worker message type: ' + msgType);
  }
  // RATIONALE: JSON boundary — worker serializes ModuleInfo via JSON.stringify/postMessage
  // ast-grep-ignore: no-type-assertion
  return JSON.parse(workerMsg.moduleInfo) as ModuleInfo;
}

async function getWorkerFile(): Promise<URL> {
  if (!import.meta.url.endsWith('.ts')) {
    return new URL('./indexingWorker.mjs', import.meta.url);
  }
  /*
    In development (tsx mode), compile the worker to plain JS using esbuild.
    Write adjacent to node_modules so external packages resolve correctly.
    Use a per-process temp file and atomic rename to avoid race conditions
    when multiple CLI processes compile concurrently.
  */
  const { build } = await import('esbuild');
  const { stat, mkdir, rename } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const srcDir = fileURLToPath(new URL('.', import.meta.url));
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const outDir = `${projectDir}/.tslor-worker-tmp`;
  const outFile = `${outDir}/indexingWorker.mjs`;
  const sourceFile = `${srcDir}indexingWorker.ts`;

  /*
    Skip recompilation if the output file exists and is newer than the source.
    This avoids redundant builds when multiple processes share the cache.
  */
  try {
    const [outStat, srcStat] = await Promise.all([
      stat(outFile),
      stat(sourceFile),
    ]);
    if (outStat.mtimeMs > srcStat.mtimeMs) {
      return new URL(`file://${outFile}`);
    }
  } catch {
    // File doesn't exist or stat failed; proceed with compilation
  }

  const tempFile = `${outFile}.${process.pid}.tmp`;
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [sourceFile],
    outfile: tempFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['ts-morph', 'esbuild'],
  });
  await rename(tempFile, outFile);
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

function createAsyncQueue<T>(): {
  writer: AsyncQueueWriter<T>;
  reader: AsyncQueueReader<T>;
} {
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
      const item = items.shift();
      if (item !== undefined) {
        return Promise.resolve(item);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise<T | null>((resolve) => waiters.push(resolve));
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
  writer: (message: string) => void,
): Promise<void> {
  let checkedCount = 0;
  let changedCount = 0;
  let processedCount = 0;
  let statDone = false;
  const abort = { value: false };

  const { writer: queueWriter, reader } = createAsyncQueue<{
    path: string;
    mtimeMs: number;
  }>();

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
      writer(
        `\rChecking ${checkedCount}/${paths.length} | Indexing ${processedCount}\x1b[K`,
      );
    } else if (changedCount > 0) {
      writer(`\rIndexing ${processedCount}/${changedCount}\x1b[K`);
    } else {
      writer(`\rChecked ${paths.length} files (no changes)\x1b[K`);
    }
  }

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
        queueWriter.push({ path, mtimeMs });
      }
      printProgress(false);
    }
    statDone = true;
    queueWriter.close();
  })();

  /*
    Complete the stat pass first. Worker compilation and spawning
    only happen if files changed, avoiding unnecessary overhead
    on incremental runs with no changes.
  */
  await statPromise;

  if (changedCount === 0) {
    printProgress(true);
    if (verbose) {
      writer('\n');
    }
    return;
  }

  const workerFile = await getWorkerFile();
  const numWorkers = cpus().length;

  async function processWorkerMessage(
    msg: unknown,
    currentItem: { path: string; mtimeMs: number },
    nextItem: { path: string; mtimeMs: number } | null,
    wrapper: WorkerWrapper,
  ): Promise<void> {
    if (nextItem) {
      wrapper.send(nextItem.path, repoRoot);
    }
    let moduleInfo: ModuleInfo | null;
    try {
      moduleInfo = parseWorkerResult(msg);
    } catch (error) {
      reThrowAsCliError(
        error,
        `Failed to process file ${currentItem.path}`,
        'unexpected',
      );
    }
    if (moduleInfo) {
      try {
        await storeImportsFromFile(
          moduleInfo,
          db,
          currentItem.mtimeMs,
          fileSystem,
        );
      } catch (error) {
        reThrowAsCliError(
          error,
          `Failed to process file ${currentItem.path}`,
          'unexpected',
        );
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

  const firstError: { value: CliError | null } = { value: null };

  async function runWorkerSafe(wrapper: WorkerWrapper): Promise<void> {
    try {
      await runWorker(wrapper);
    } catch (err) {
      if (!firstError.value) {
        firstError.value =
          err instanceof CliError
            ? err
            : new CliError(err instanceof Error ? err.message : String(err), {
                cause: err,
                expectedness: 'unexpected',
              });
      }
      wrapper.terminate();
      abort.value = true;
      queueWriter.close();
    }
  }

  const workers = Array.from({ length: numWorkers }, () =>
    createWorkerWrapper(workerFile),
  );
  await Promise.all(workers.map(runWorkerSafe));

  printProgress(true);
  if (verbose) {
    writer('\n');
  }

  if (firstError.value) {
    throw firstError.value;
  }
}

async function refreshImportsFromFile(
  db: Storage,
  somePath: string,
  repoRoot: string,
  fileSystem: FileSystem,
) {
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
    reThrowAsCliError(error, `Failed to process file ${somePath}`, 'unexpected');
  }
}

async function storeImportsFromFile(
  moduleInfo: ModuleInfo,
  db: Storage,
  mtimeMs: number,
  fileSystem: FileSystem,
) {
  db.deleteImporterPath(moduleInfo.path);

  let pos = 0;
  for (const imp of moduleInfo.imports) {
    const exporterTsConfig = await getTsconfigPathForFile(
      moduleInfo.repoRoot,
      imp.path,
      fileSystem,
    );
    if (!exporterTsConfig) {
      throw new CliError('No tsconfig found for ' + imp.path, {});
    }
    db.putImport(moduleInfo.path, moduleInfo.tsconfig, pos++, imp.name, {
      path: imp.path,
      tsconfig: exporterTsConfig,
    });
  }

  for (const imp of moduleInfo.unresolvedImports) {
    db.putImport(moduleInfo.path, moduleInfo.tsconfig, pos++, imp.name, {
      spec: imp.moduleSpecifier,
    });
  }

  for (const imp of moduleInfo.sideEffectImports) {
    const exporterTsConfig = await getTsconfigPathForFile(
      moduleInfo.repoRoot,
      imp.path,
      fileSystem,
    );
    if (!exporterTsConfig) {
      throw new CliError('No tsconfig found for ' + imp.path, {});
    }
    db.putSideEffectImport(moduleInfo.path, moduleInfo.tsconfig, {
      path: imp.path,
      tsconfig: exporterTsConfig,
    });
  }

  for (const [i, reExport] of moduleInfo.reExports.entries()) {
    db.putReExport(moduleInfo.path, i, reExport.name, {
      moduleSpec: reExport.moduleSpec,
      isTypeOnly: reExport.isTypeOnly,
      ...(reExport.resolvedPath !== undefined && {
        resolvedPath: reExport.resolvedPath,
      }),
    });
  }

  db.putModuleNeeds(moduleInfo.path, { ambientNames: moduleInfo.ambientNames });
  db.addFileTimestamp(moduleInfo.path, mtimeMs);
}
