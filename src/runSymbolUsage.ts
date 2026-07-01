import { updateStorage } from "./indexing";
import { findGitRepoRoot } from "./project";
import { openStorage, isObjWithExporterPath } from "./storage";
import { DebugOptions } from "./objstore";
import { normalizePath, isPathWithinDirectory } from "./pathUtils";
import { FileSystem } from "./filesystem";

function collectExporterPaths(
  symbolImports: ReadonlyArray<import('./objstore').Obj>,
  absoluteProjectPath: string
): string[] {
  const paths: string[] = [];
  for (const obj of symbolImports) {
    if (!isObjWithExporterPath(obj)) {
      continue;
    }
    if (
      isPathWithinDirectory(obj.exporter.path, absoluteProjectPath) &&
      !paths.includes(obj.exporter.path)
    ) {
      paths.push(obj.exporter.path);
    }
  }
  return paths;
}

export async function runSymbolUsage(
  projectPath: string,
  symbolName: string,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
) {
  const absoluteProjectPath = normalizePath(projectPath);
  const repoRoot = findGitRepoRoot(absoluteProjectPath);
  const db = openStorage(debugOptions, { verbose: true, inMemory: false });
  await updateStorage(repoRoot, db, true, fileSystem, (msg) => console.log(msg));

  console.log('⚠️  WARNING: This command uses loose symbol name matching and may return');
  console.log('   unrelated symbols with the same name from different modules.');
  console.log('   Use this for exploration only, NOT for refactoring decisions.');
  console.log('   For refactoring, use fully qualified symbol analysis instead.');
  console.log();

  const symbolImports = db.getSymbolImports(symbolName);
  const allExporterPaths = collectExporterPaths(symbolImports, absoluteProjectPath);

  if (allExporterPaths.length === 0) {
    console.log(`Symbol '${symbolName}' not found in project ${absoluteProjectPath}`);
    return;
  }

  console.log(`Symbol '${symbolName}' exported by:`);
  allExporterPaths.sort();
  for (const exporterPath of allExporterPaths) {
    console.log(`  ${exporterPath}`);
  }
  console.log();

  for (const exporterPath of allExporterPaths) {
    const importers = db.getImportersOfExport(exporterPath, symbolName);
    if (importers.length > 0) {
      console.log(`${exporterPath}:${symbolName} used by:`);
      importers.sort();
      for (const importerPath of importers) {
        console.log(`  ${importerPath}`);
      }
      console.log();
    }
  }

  db.save();
}

