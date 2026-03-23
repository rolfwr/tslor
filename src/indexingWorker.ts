/**
 * Worker thread entry point for parallel file indexing.
 *
 * Receives { type: 'index', path, repoRoot } messages from the main thread,
 * runs inspectModule() on each file, and posts back the serialized ModuleInfo.
 */

import { parentPort } from 'node:worker_threads';
import { inspectModule } from './indexing.js';
import { RealFileSystem } from './filesystem.js';

if (!parentPort) {
  throw new Error('indexingWorker must be run as a worker thread');
}

const fileSystem = new RealFileSystem();

parentPort.on('message', (msg: { type: string; path: string; repoRoot: string }) => {
  if (msg.type !== 'index') return;
  const { path, repoRoot } = msg;
  inspectModule(repoRoot, path, fileSystem)
    .then((moduleInfo) => {
      parentPort!.postMessage({ type: 'result', moduleInfo: JSON.stringify(moduleInfo) });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      parentPort!.postMessage({ type: 'error', error: message });
    });
});
