import { updateStorage } from './indexing';
import { findGitRepoRoot } from './project';
import { openStorage } from './storage';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath } from './pathUtils';
import { FileSystem } from './filesystem';

export interface ProjectUseOptions {
  symbols?: boolean;
}

function displaySymbolsByExporter(
  exportersBySymbol: Map<string, Map<string, Set<string>>>,
  writer: (message: string) => void,
): void {
  if (exportersBySymbol.size === 0) {
    writer('No cross-project dependencies found.\n');
    return;
  }

  const exporters = Array.from(exportersBySymbol.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [exporterPath, symbolMap] of exporters) {
    writer(exporterPath + ':\n');
    const symbols = Array.from(symbolMap.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [symbol, importers] of symbols) {
      const importerPaths = Array.from(importers).sort();
      writer(`  ${symbol} used by:\n`);
      for (const importerPath of importerPaths) {
        writer(`    ${importerPath}\n`);
      }
    }
    writer('\n');
  }
}

function displayFilesByExporter(
  importersByExporter: Map<string, Set<string>>,
  writer: (message: string) => void,
): void {
  if (importersByExporter.size === 0) {
    writer('No cross-project dependencies found.\n');
    return;
  }

  const exporters = Array.from(importersByExporter.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [exporterPath, importers] of exporters) {
    writer(exporterPath + ' used by:\n');
    const importerPaths = Array.from(importers).sort();
    for (const importerPath of importerPaths) {
      writer('  ' + importerPath + '\n');
    }
    writer('\n');
  }
}

export async function runProjectUse(
  fromTsconfig: string,
  toTsconfig: string,
  options: ProjectUseOptions,
  debugOptions: DebugOptions,
  fresh: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  const absoluteFromTsconfig = normalizeAndValidatePath(
    fromTsconfig,
    'From tsconfig',
    false,
  );
  const absoluteToTsconfig = normalizeAndValidatePath(
    toTsconfig,
    'To tsconfig',
    false,
  );
  const repoRoot = findGitRepoRoot(absoluteFromTsconfig);
  const db = openStorage(debugOptions, {
    verbose: true,
    fresh,
    basePath: repoRoot,
    inMemory: false,
  });
  await updateStorage(repoRoot, db, true, fileSystem, writer);

  if (options.symbols) {
    const usesWithSymbols = db.getProjectUsesWithSymbols(
      absoluteFromTsconfig,
      absoluteToTsconfig,
    );
    const exportersBySymbol = new Map<string, Map<string, Set<string>>>();
    for (const use of usesWithSymbols) {
      let symbolMap = exportersBySymbol.get(use.exporterPath);
      if (!symbolMap) {
        symbolMap = new Map();
        exportersBySymbol.set(use.exporterPath, symbolMap);
      }
      let importers = symbolMap.get(use.symbolName);
      if (!importers) {
        importers = new Set();
        symbolMap.set(use.symbolName, importers);
      }
      importers.add(use.importerPath);
    }
    displaySymbolsByExporter(exportersBySymbol, writer);
  } else {
    const uses = db.getProjectUses(absoluteFromTsconfig, absoluteToTsconfig);
    const importersByExporter = new Map<string, Set<string>>();
    for (const use of uses) {
      let importers = importersByExporter.get(use.exporterPath);
      if (!importers) {
        importers = new Set();
        importersByExporter.set(use.exporterPath, importers);
      }
      importers.add(use.importerPath);
    }
    displayFilesByExporter(importersByExporter, writer);
  }

  db.save();
}
