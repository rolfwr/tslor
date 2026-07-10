import { findGitRepoRoot } from './project';
import { openStorage } from './storage';
import { updateStorage } from './indexing';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath } from './pathUtils';
import { FileSystem } from './filesystem';

export async function runImports(
  exportPathArg: string,
  debugOptions: DebugOptions,
  fresh: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
  verbose: boolean,
) {
  const exportPath = normalizeAndValidatePath(
    exportPathArg,
    'Export path',
    false,
  );
  const repoRoot = findGitRepoRoot(exportPath);
  const db = openStorage(debugOptions, {
    verbose,
    fresh,
    basePath: repoRoot,
    inMemory: false,
  });
  await updateStorage(repoRoot, db, verbose, fileSystem, writer, {});
  db.save();
  const importers = db.getImportersOfExportPath(exportPath);
  const sortedImporters = Array.from(importers).sort();
  for (const importer of sortedImporters) {
    writer(importer + '\n');
  }
}
