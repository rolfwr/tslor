/**
 * Worker thread entry point for parallel file indexing.
 *
 * Receives { type: 'index', path, repoRoot } messages from the main thread,
 * runs inspectModule() on each file, and posts back the serialized ModuleInfo.
 */

import { parentPort as pp } from 'node:worker_threads';

const parentPort = pp;
if (!parentPort) {
  throw new Error('indexingWorker must be run as a worker thread');
}
import { inspectModule } from './indexing.js';
import { RealFileSystem } from './filesystem.js';



const fileSystem = new RealFileSystem();

parentPort.on('message', (msg: { type: string; path: string; repoRoot: string }) => {
  if (msg.type !== 'index') {
    return;
  }
  const { path, repoRoot } = msg;
  inspectModule(repoRoot, path, fileSystem)
    .then((moduleInfo) => {
      if (!moduleInfo) {
        parentPort.postMessage({ type: 'skip', path, reason: 'no tsconfig' });
      } else {
        parentPort.postMessage({ type: 'result', moduleInfo: JSON.stringify(moduleInfo) });
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      parentPort.postMessage({ type: 'error', error: message });
    });
});
