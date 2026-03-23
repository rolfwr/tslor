import { updateStorage } from "./indexing.js";
import { findGitRepoRoot, getTsconfigPathForFile } from "./project.js";
import { openStorage, Storage } from "./storage.js";
import { DebugOptions } from "./objstore.js";
import { normalizePaths } from "./pathUtils.js";
import { FileSystem } from "./filesystem.js";

export async function runDependencies(modulePaths: string[], commandOptions: { projectScope: boolean }, debugOptions: DebugOptions, fileSystem: FileSystem) {
  // Resolve all paths to absolute paths early
  const absoluteModulePaths = normalizePaths(modulePaths);

  const tsPath = absoluteModulePaths[0];
  const repoRoot = findGitRepoRoot(tsPath);
  const db = openStorage(debugOptions, true);
  await updateStorage(repoRoot, db, true, fileSystem);

  const tsconfigPath = commandOptions.projectScope ? await getTsconfigPathForFile(repoRoot, tsPath, fileSystem) : null;
  const seen = new Set<string>();
  for (const tsPath of absoluteModulePaths) {
    dumpDependenciesFor(db, tsPath, seen, tsconfigPath);
  }
}

function dumpDependenciesFor(db: Storage, tsPath: string, seen: Set<string>, tsconfigPathScope: string | null) {
  if (seen.has(tsPath)) {
    return;
  }
  seen.add(tsPath);

  const exporters = db.getExporterPathsOfImport(tsPath);
  for (const exporter of exporters) {
    if (tsconfigPathScope && tsconfigPathScope !== exporter.tsconfig) {
      continue;
    }
    dumpDependenciesFor(db, exporter.path, seen, tsconfigPathScope);
  }

  console.log(tsPath);
}
