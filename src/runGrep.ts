import { updateStorage } from "./indexing.js";
import { findGitRepoRoot } from "./project.js";
import { openStorage } from "./storage.js";
import { DebugOptions } from "./objstore.js";
import { normalizePath } from "./pathUtils.js";
import { FileSystem } from "./filesystem.js";

export interface GrepOptions {
  uses?: boolean;
  verbose?: boolean;
}

export async function runGrep(
  directory: string,
  symbolName: string,
  options: GrepOptions,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
) {
  const absoluteDirectory = normalizePath(directory);
  const repoRoot = findGitRepoRoot(absoluteDirectory);
  const db = openStorage(debugOptions, options.verbose || false);
  await updateStorage(repoRoot, db, options.verbose || false, fileSystem);

  // Use efficient symbolName group index for discovery
  const symbolImports = db.getSymbolImports(symbolName);
  
  if (symbolImports.length === 0) {
    return;
  }

  // Group by exporter (where symbol is defined)
  const exportersByPath = new Map<string, Set<string>>();
  const importersByExporter = new Map<string, Set<string>>();
  
  for (const obj of symbolImports) {
    const exporter = obj.exporter;
    
    if (exporter && typeof exporter === 'object' && 'path' in exporter) {
      const exporterPath = exporter.path;
      
      if (typeof exporterPath === 'string' && isWithinDirectory(exporterPath, absoluteDirectory)) {
        // Track this exporter
        if (!exportersByPath.has(exporterPath)) {
          exportersByPath.set(exporterPath, new Set());
        }
        exportersByPath.get(exporterPath)!.add(symbolName);
        
        // Track importer if we need to show usage
        if (options.uses) {
          const id = obj.id;
          if (typeof id === 'string' && id.startsWith('import|')) {
            const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));
            if (!importersByExporter.has(exporterPath)) {
              importersByExporter.set(exporterPath, new Set());
            }
            importersByExporter.get(exporterPath)!.add(importerPath);
          }
        }
      }
    }
  }

  if (exportersByPath.size === 0) {
    return;
  }

  // Display results
  const exporterPaths = Array.from(exportersByPath.keys());
  exporterPaths.sort();

  for (const exporterPath of exporterPaths) {
    console.log(exporterPath);
    
    if (options.uses) {
      const importers = importersByExporter.get(exporterPath);
      if (importers && importers.size > 0) {
        const importerPaths = Array.from(importers);
        importerPaths.sort();
        for (const importerPath of importerPaths) {
          console.log(`  ${importerPath}`);
        }
      }
    }
  }

  db.save();
}

function isWithinDirectory(filePath: string, directoryPath: string): boolean {
  try {
    const absoluteFilePath = normalizePath(filePath);
    const absoluteDirectoryPath = normalizePath(directoryPath);
    
    // Check if the file is within the directory
    return absoluteFilePath.startsWith(absoluteDirectoryPath);
  } catch {
    // If there's an error with path resolution, be conservative and exclude
    return false;
  }
}