import { updateStorage } from "./indexing.js";
import { findGitRepoRoot } from "./project.js";
import { openStorage } from "./storage.js";
import { DebugOptions } from "./objstore.js";
import { normalizeAndValidatePath, normalizePath } from "./pathUtils.js";
import { FileSystem } from "./filesystem.js";

export interface TraceImportsOptions {
  fromProject?: string;
}

export async function runTraceImports(
  entryFile: string,
  options: TraceImportsOptions,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
) {
  const absoluteEntryFile = normalizeAndValidatePath(entryFile, "Entry file", false);
  const repoRoot = findGitRepoRoot(absoluteEntryFile);
  const db = openStorage(debugOptions, true);
  await updateStorage(repoRoot, db, true, fileSystem);

  console.log(`Tracing imports from: ${absoluteEntryFile}`);
  if (options.fromProject) {
    console.log(`Filtering imports from project: ${options.fromProject}`);
  }
  console.log();

  // Use existing group index to get all imports from the entry file
  const importObjects = db.getImportsFromFile(absoluteEntryFile);
  
  if (importObjects.length === 0) {
    console.log('No imports found from this file');
    return;
  }

  // Group imports by exporter path and collect symbol information
  const importsByExporter = new Map<string, Set<string>>();
  
  for (const obj of importObjects) {
    const exporter = obj.exporter;
    
    if (exporter && typeof exporter === 'object' && 'path' in exporter) {
      const exporterPath = exporter.path;
      
      if (typeof exporterPath !== 'string') {
        continue;
      }
      
      // Filter by project if specified
      if (options.fromProject && !isWithinProject(exporterPath, options.fromProject)) {
        continue;
      }
      
      // Extract symbol names from export groups
      const groups = obj.groups || [];
      for (const group of groups) {
        if (typeof group === 'string' && group.startsWith('export|' + exporterPath + '|')) {
          const symbolName = group.split('|')[2];
          if (symbolName) {
            let symbols = importsByExporter.get(exporterPath);
            if (!symbols) {
              symbols = new Set();
              importsByExporter.set(exporterPath, symbols);
            }
            symbols.add(symbolName);
          }
        }
      }
    }
  }

  if (importsByExporter.size === 0) {
    if (options.fromProject) {
      console.log(`No imports found from project: ${options.fromProject}`);
    } else {
      console.log('No resolved imports found');
    }
    return;
  }

  // Display results grouped by exporter file
  const exporterPaths = Array.from(importsByExporter.keys());
  exporterPaths.sort();

  let totalSymbols = 0;
  for (const exporterPath of exporterPaths) {
    const symbols = importsByExporter.get(exporterPath);
    if (!symbols) continue;
    
    totalSymbols += symbols.size;
    console.log(`${exporterPath}:`);
    
    const sortedSymbols = Array.from(symbols);
    sortedSymbols.sort();
    
    for (const symbol of sortedSymbols) {
      console.log(`  ${symbol}`);
    }
    console.log();
  }

  console.log(`Total: ${totalSymbols} symbols from ${exporterPaths.length} files`);

  db.save();
}

function isWithinProject(filePath: string, projectPath: string): boolean {
  try {
    const absoluteFilePath = normalizePath(filePath);
    const absoluteProjectPath = normalizePath(projectPath);
    
    // Check if the file is within the project directory
    return absoluteFilePath.startsWith(absoluteProjectPath);
  } catch (error) {
    // If there's an error with path resolution, be conservative and exclude
    return false;
  }
}