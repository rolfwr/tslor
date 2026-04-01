import { updateStorage } from "./indexing";
import { findGitRepoRoot } from "./project";
import { openStorage } from "./storage";
import { DebugOptions } from "./objstore";
import { normalizePath } from "./pathUtils";
import { FileSystem } from "./filesystem";

export async function runSymbolUsage(
  projectPath: string,
  symbolName: string,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
) {
  const absoluteProjectPath = normalizePath(projectPath);
  const repoRoot = findGitRepoRoot(absoluteProjectPath);
  const db = openStorage(debugOptions, true);
  await updateStorage(repoRoot, db, true, fileSystem);

  console.log('⚠️  WARNING: This command uses loose symbol name matching and may return');
  console.log('   unrelated symbols with the same name from different modules.');
  console.log('   Use this for exploration only, NOT for refactoring decisions.');
  console.log('   For refactoring, use fully qualified symbol analysis instead.');
  console.log();

  // Find all files that export the given symbol within the project
  // Use efficient group index to find all imports of this symbol name
  // NOTE: This is a LOOSE search - same symbol names from different modules will match!
  const symbolImports = db.getSymbolImports(symbolName);
  const allExporterPaths: string[] = [];
  
  for (const obj of symbolImports) {
    const exporter = obj.exporter;
    if (exporter && typeof exporter === 'object' && 'path' in exporter) {
      const exporterPath = exporter.path;
      if (typeof exporterPath === 'string' && isWithinProject(exporterPath, absoluteProjectPath)) {
        if (!allExporterPaths.includes(exporterPath)) {
          allExporterPaths.push(exporterPath);
        }
      }
    }
  }

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

  // For each exporter, find all importers
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

function isWithinProject(filePath: string, projectPath: string): boolean {
  try {
    const absoluteFilePath = normalizePath(filePath);
    const absoluteProjectPath = normalizePath(projectPath);
    
    // Check if the file is within the project directory
    return absoluteFilePath.startsWith(absoluteProjectPath);
  } catch {
    // If there's an error with path resolution, be conservative and exclude
    return false;
  }
}