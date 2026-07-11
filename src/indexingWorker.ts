/**
 * Worker thread entry point for parallel file indexing.
 *
 * Receives { type: 'index', path, repoRoot } messages from the main thread,
 * runs the cached module inspector on each file, and posts back the
 * serialized ModuleInfo.
 *
 * Uses createModuleInspector() which caches tsconfig path lookups and
 * compiler options across files.
 */

import { parentPort as pp } from 'node:worker_threads';

const parentPort = pp;
if (!parentPort) {
  throw new Error('indexingWorker must be run as a worker thread');
}
import { createModuleInspector } from './inspectModule';
import { RealFileSystem } from './filesystem';

const fileSystem = new RealFileSystem();

/*
  Create a single cached inspector for the lifetime of this worker.
  Files are processed sequentially (never concurrently within a worker),
  so the internal caches are safe to share.
*/
const inspect = createModuleInspector(fileSystem);

parentPort.on(
  'message',
  (msg: { type: string; path: string; repoRoot: string }) => {
    if (msg.type !== 'index') {
      return;
    }
    const { path, repoRoot } = msg;
    inspect(repoRoot, path)
      .then((moduleInfo) => {
        if (moduleInfo === null) {
          parentPort.postMessage({ type: 'skip', path, reason: 'no tsconfig' });
          return;
        }
        parentPort.postMessage({
          type: 'result',
          moduleInfo: JSON.stringify(moduleInfo),
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        parentPort.postMessage({ type: 'error', error: message });
      });
  },
);
