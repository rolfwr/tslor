import { updateStorage } from "./indexing";
import { findGitRepoRoot } from "./project";
import { openStorage, Storage } from "./storage";
import { DebugOptions } from "./objstore";
import { normalizeAndValidatePath } from "./pathUtils";
import { FileSystem } from "./filesystem";

export interface TypeLeafUsageOptions {
  all?: boolean;
}

export async function runTypeLeafUsage(
  directoryArg: string,
  typeNames: string[],
  options: TypeLeafUsageOptions,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
): Promise<void> {
  const directory = normalizeAndValidatePath(directoryArg, "Directory", false);
  const repoRoot = findGitRepoRoot(directory);
  const db = openStorage(debugOptions, true);
  await updateStorage(repoRoot, db, true, fileSystem);
  db.save();

  const { importers, definers } = findFilesUsingTypes(db, typeNames, directory);

  if (importers.size === 0) {
    console.log(`No files found importing ${typeNames.join(', ')}.`);
    return;
  }

  const candidateSet = options.all ? importers : new Set([...importers].filter(f => !definers.has(f)));

  const leaves = findLeaves(db, candidateSet);

  console.log(`Found ${importers.size} files importing [${typeNames.join(', ')}], ${leaves.length} are leaves.`);
  for (const leaf of leaves) {
    console.log(leaf);
  }
}

function findFilesUsingTypes(db: Storage, typeNames: string[], directory: string): { importers: Set<string>, definers: Set<string> } {
  const directoryPrefix = directory.endsWith('/') ? directory : directory + '/';
  const importers = new Set<string>();
  const definers = new Set<string>();

  for (const typeName of typeNames) {
    const symbolImports = db.getSymbolImports(typeName);
    for (const obj of symbolImports) {
      const id = obj.id;
      const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));
      if (!importerPath.startsWith(directoryPrefix)) {
        continue;
      }
      importers.add(importerPath);

      const exporter = obj.exporter as { path?: string } | undefined;
      if (exporter && typeof exporter.path === 'string') {
        definers.add(exporter.path);
      }
    }
  }

  return { importers, definers };
}

function findLeaves(db: Storage, candidateSet: Set<string>): string[] {
  // Memoized check: does filePath transitively import any member of candidateSet?
  const memo = new Map<string, boolean>();

  function hasCanditateDependency(filePath: string): boolean {
    const cached = memo.get(filePath);
    if (cached !== undefined) return cached;

    // Mark as visiting (false) to handle cycles
    memo.set(filePath, false);

    const directImports = db.getExporterPathsOfImport(filePath);
    for (const dep of directImports) {
      if (candidateSet.has(dep.path)) {
        memo.set(filePath, true);
        return true;
      }
      if (hasCanditateDependency(dep.path)) {
        memo.set(filePath, true);
        return true;
      }
    }

    return false;
  }

  const leaves: string[] = [];
  for (const filePath of candidateSet) {
    if (!hasCanditateDependency(filePath)) {
      leaves.push(filePath);
    }
  }

  return leaves.sort();
}
