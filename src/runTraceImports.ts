import { updateStorage } from "./indexing";
import { findGitRepoRoot } from "./project";
import { openStorage, isObjWithExporterPath } from "./storage";
import { DebugOptions } from "./objstore";
import { normalizeAndValidatePath, normalizePath } from "./pathUtils";
import { FileSystem } from "./filesystem";

export interface TraceImportsOptions {
  fromProject?: string;
}

function getExporterPathFromObj(obj: import("./objstore").Obj): string | null {
  if (!isObjWithExporterPath(obj)) {
    return null;
  }
  return obj.exporter.path;
}

function addGroupSymbols(
  groups: unknown[],
  exporterPath: string,
  map: Map<string, Set<string>>
): void {
  for (const group of groups) {
    if (typeof group !== 'string' || !group.startsWith('export|' + exporterPath + '|')) {
      continue;
    }
    const symbolName = group.split('|')[2];
    if (!symbolName) {
      continue;
    }
    let symbols = map.get(exporterPath);
    if (!symbols) {
      symbols = new Set();
      map.set(exporterPath, symbols);
    }
    symbols.add(symbolName);
  }
}

function buildImportsByExporter(
  importObjects: ReadonlyArray<import("./objstore").Obj>,
  options: TraceImportsOptions
): Map<string, Set<string>> {
  const importsByExporter = new Map<string, Set<string>>();

  for (const obj of importObjects) {
    const exporterPath = getExporterPathFromObj(obj);
    if (!exporterPath) {
      continue;
    }
    if (options.fromProject && !isWithinProject(exporterPath, options.fromProject)) {
      continue;
    }
    addGroupSymbols((obj['groups'] as unknown[]) || [], exporterPath, importsByExporter);
  }

  return importsByExporter;
}

function displayTraceResults(importsByExporter: Map<string, Set<string>>): void {
  const exporterPaths = Array.from(importsByExporter.keys()).sort();
  let totalSymbols = 0;
  for (const exporterPath of exporterPaths) {
    const symbols = importsByExporter.get(exporterPath);
    if (!symbols) {
      continue;
    }
    totalSymbols += symbols.size;
    console.log(`${exporterPath}:`);
    const sortedSymbols = Array.from(symbols).sort();
    for (const symbol of sortedSymbols) {
      console.log(`  ${symbol}`);
    }
    console.log();
  }
  console.log(`Total: ${totalSymbols} symbols from ${exporterPaths.length} files`);
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

  const importObjects = db.getImportsFromFile(absoluteEntryFile);
  if (importObjects.length === 0) {
    console.log('No imports found from this file');
    return;
  }

  const importsByExporter = buildImportsByExporter(importObjects, options);

  if (importsByExporter.size === 0) {
    if (options.fromProject) {
      console.log(`No imports found from project: ${options.fromProject}`);
    } else {
      console.log('No resolved imports found');
    }
    return;
  }

  displayTraceResults(importsByExporter);
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