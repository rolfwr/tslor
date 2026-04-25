import { updateStorage } from "./indexing";
import { findGitRepoRoot } from "./project";
import { openStorage, isObjWithExporterPath } from "./storage";
import { DebugOptions } from "./objstore";
import { normalizePath } from "./pathUtils";
import { FileSystem } from "./filesystem";

export interface GrepOptions {
  uses?: boolean;
  verbose?: boolean;
}

interface ExporterIndexes {
  exportersByPath: Map<string, Set<string>>;
  importersByExporter: Map<string, Set<string>>;
}

function extractExporterPath(obj: import('./objstore').Obj): string | null {
  if (!isObjWithExporterPath(obj)) {
    return null;
  }
  return obj.exporter.path;
}

function extractImporterPath(id: unknown): string | null {
  if (typeof id !== 'string' || !id.startsWith('import|')) {
    return null;
  }
  return id.slice('import|'.length, id.lastIndexOf('|'));
}

function buildExporterIndexes(
  symbolImports: ReadonlyArray<import('./objstore').Obj>,
  symbolName: string,
  absoluteDirectory: string,
  options: GrepOptions
): ExporterIndexes {
  const exportersByPath = new Map<string, Set<string>>();
  const importersByExporter = new Map<string, Set<string>>();

  for (const obj of symbolImports) {
    const exporterPath = extractExporterPath(obj);
    if (!exporterPath || !isWithinDirectory(exporterPath, absoluteDirectory)) {
      continue;
    }
    let exporters = exportersByPath.get(exporterPath);
    if (!exporters) {
      exporters = new Set();
      exportersByPath.set(exporterPath, exporters);
    }
    exporters.add(symbolName);

    if (options.uses) {
      const importerPath = extractImporterPath(obj.id);
      if (importerPath) {
        let importers = importersByExporter.get(exporterPath);
        if (!importers) {
          importers = new Set();
          importersByExporter.set(exporterPath, importers);
        }
        importers.add(importerPath);
      }
    }
  }

  return { exportersByPath, importersByExporter };
}

function displayExporterResults(
  exportersByPath: Map<string, Set<string>>,
  importersByExporter: Map<string, Set<string>>,
  options: GrepOptions
): void {
  const exporterPaths = Array.from(exportersByPath.keys()).sort();
  for (const exporterPath of exporterPaths) {
    console.log(exporterPath);
    if (!options.uses) {
      continue;
    }
    const importers = importersByExporter.get(exporterPath);
    if (!importers || importers.size === 0) {
      continue;
    }
    const importerPaths = Array.from(importers).sort();
    for (const importerPath of importerPaths) {
      console.log(`  ${importerPath}`);
    }
  }
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

  const symbolImports = db.getSymbolImports(symbolName);
  if (symbolImports.length === 0) {
    return;
  }

  const { exportersByPath, importersByExporter } = buildExporterIndexes(
    symbolImports,
    symbolName,
    absoluteDirectory,
    options
  );

  if (exportersByPath.size === 0) {
    return;
  }

  displayExporterResults(exportersByPath, importersByExporter, options);

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