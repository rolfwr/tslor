import { updateStorage } from "./indexing.js";
import { findGitRepoRoot } from "./project.js";
import { openStorage } from "./storage.js";
import { DebugOptions } from "./objstore.js";
import { normalizeAndValidatePath } from "./pathUtils.js";
import { FileSystem } from "./filesystem.js";

export interface ProjectUseOptions {
  showSymbols?: boolean;
}

export async function runProjectUse(
  fromTsconfig: string,
  toTsconfig: string,
  options: ProjectUseOptions,
  debugOptions: DebugOptions,
  fileSystem: FileSystem
) {
  const absoluteFromTsconfig = normalizeAndValidatePath(fromTsconfig, "From tsconfig", false);
  const absoluteToTsconfig = normalizeAndValidatePath(toTsconfig, "To tsconfig", false);
  const repoRoot = findGitRepoRoot(absoluteFromTsconfig);
  const db = openStorage(debugOptions, true);
  await updateStorage(repoRoot, db, true, fileSystem);

  if (options.showSymbols) {
    const usesWithSymbols = db.getProjectUsesWithSymbols(absoluteFromTsconfig, absoluteToTsconfig);
    
    // Group by exporter path and symbol
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
    
    const exporterPaths = Array.from(exportersBySymbol.keys());
    exporterPaths.sort();
    
    for (const exporterPath of exporterPaths) {
      console.log(exporterPath + ':');
      const symbolMap = exportersBySymbol.get(exporterPath);
      if (!symbolMap) continue;
      
      const symbols = Array.from(symbolMap.keys());
      symbols.sort();
      
      for (const symbol of symbols) {
        const importers = symbolMap.get(symbol);
        if (!importers) continue;
        
        const importerPaths = Array.from(importers);
        importerPaths.sort();
        
        console.log(`  ${symbol} used by:`);
        for (const importerPath of importerPaths) {
          console.log(`    ${importerPath}`);
        }
      }
      console.log();
    }
  } else {
    // Original behavior - show file-level dependencies
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

    const exporterPaths = Array.from(importersByExporter.keys());
    exporterPaths.sort();
    for (const exporterPath of exporterPaths) {
      console.log(exporterPath + ' used by:');
      const importers = importersByExporter.get(exporterPath);
      if (!importers) {
        throw new Error('No importers found');
      }
      const importerPaths = Array.from(importers);
      importerPaths.sort();
      for (const importerPath of importerPaths) {
        console.log('  ' + importerPath);
      }
      console.log();
    }
  }

  db.save();
}
