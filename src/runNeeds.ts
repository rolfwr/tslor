import { findGitRepoRoot } from './project';
import { openStorage, type Storage } from './storage';
import { updateStorage } from './indexing';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath, denormalizePath } from './pathUtils';
import { FileSystem } from './filesystem';

export async function runNeeds(
  modulePath: string,
  debugOptions: DebugOptions,
  fresh: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
  verbose: boolean,
) {
  const absolutePath = normalizeAndValidatePath(
    modulePath,
    'Module path',
    false,
  );
  const repoRoot = findGitRepoRoot(absolutePath);

  const db = openStorage(debugOptions, {
    verbose,
    fresh,
    basePath: repoRoot,
    inMemory: false,
  });
  await updateStorage(repoRoot, db, verbose, fileSystem, writer, {});
  db.save();

  // Find transitive Node.js requirements
  const nodejsPath = findNodejsRequirement(db, absolutePath, new Set());

  if (nodejsPath) {
    writer(modulePath + ' needs nodejs:\n');
    for (const p of nodejsPath) {
      writer('  ' + denormalizePath(p, repoRoot) + '\n');
    }
  } else {
    writer('No Node.js requirements found.\n');
  }
}

/**
 * Find any import path from the given module to a module that requires Node.js.
 * Uses depth-first search with cycle detection.
 * Returns the path as an array of module paths, or null if no Node.js requirement found.
 */
function findNodejsRequirement(
  db: Storage,
  modulePath: string,
  visited: Set<string>,
): string[] | null {
  // Avoid cycles
  if (visited.has(modulePath)) {
    return null;
  }
  visited.add(modulePath);

  // Check if this module directly needs Node.js
  const needs = db.getModuleNeeds(modulePath);
  if (needs && needs.ambientNames.length > 0) {
    return [modulePath];
  }

  // Recursively check dependencies
  const dependencies = db.getExporterPathsOfImport(modulePath);
  for (const dep of dependencies) {
    const depPath = findNodejsRequirement(db, dep.path, visited);
    if (depPath) {
      // Found a path - prepend current module and return
      return [modulePath, ...depPath];
    }
  }

  // No Node.js requirement found in this branch
  return null;
}
