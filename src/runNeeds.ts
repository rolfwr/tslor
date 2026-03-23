import { findGitRepoRoot } from "./project";
import { openStorage, type Storage } from "./storage";
import { updateStorage } from "./indexing";
import { DebugOptions } from "./objstore";
import { normalizeAndValidatePath, denormalizePath } from "./pathUtils";
import { FileSystem } from "./filesystem";

export async function runNeeds(modulePath: string, debugOptions: DebugOptions, fileSystem: FileSystem) {
  const absolutePath = normalizeAndValidatePath(modulePath, "Module path", false);
  const repoRoot = findGitRepoRoot(absolutePath);

  // Only show progress in interactive terminals (not when piped or run by automation tools)
  const isInteractive = process.stdout.isTTY && !process.env.CI;
  const db = openStorage(debugOptions, isInteractive);
  await updateStorage(repoRoot, db, isInteractive, fileSystem);
  db.save();

  // Find transitive Node.js requirements
  const nodejsPath = findNodejsRequirement(db, absolutePath, new Set());

  if (nodejsPath) {
    console.log(modulePath + ' needs nodejs:');
    for (const path of nodejsPath) {
      console.log('  ' + denormalizePath(path, process.cwd()));
    }
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
  visited: Set<string>
): string[] | null {
  // Avoid cycles
  if (visited.has(modulePath)) {
    return null;
  }
  visited.add(modulePath);

  // Check if this module directly needs Node.js
  const needs = db.getModuleNeeds(modulePath);
  if (needs?.nodejs) {
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