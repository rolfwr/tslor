import { existsSync } from 'fs';
import { loadObjStoreFromJsonl, ObjStore, saveObjStoreAsJsonl, DebugOptions, Obj } from './objstore';

/**
 * Reference to a module that exports something.
 * Can be either a resolved file path or an unresolved import specifier.
 */
interface ExporterPath {
  path: string;
  tsconfig: string;
}

interface ExporterSpec {
  spec: string;
}

interface ReExportInfo {
  moduleSpec: string;
  isTypeOnly: boolean;
}

type Exporter = ExporterPath | ExporterSpec;

function isExporterPath(obj: unknown): obj is ExporterPath {
  if (typeof obj !== 'object') {
    return false;
  }
  if (obj === null) {
    return false;
  }
  return 'path' in obj && 'tsconfig' in obj;
} 

/**
 * High-level interface for TSLOR's indexing system.
 * 
 * This class provides a domain-specific API over the generic ObjStore,
 * with methods for storing and querying TypeScript import/export relationships.
 * 
 * The underlying storage uses a grouped indexing strategy where objects
 * belong to multiple named groups for efficient queries:
 * 
 * - import|{importerPath}|{index} - Individual import statements
 * - importPath|{importerPath} - All imports from a file
 * - export|{exporterPath}|{exportName} - Specific exports
 * - exportPath|{exporterPath} - All exports from a file
 * - projectUse|{fromTsconfig}|{toTsconfig} - Cross-project dependencies
 * - symbolName|{symbolName} - All imports of a specific symbol name (for efficient symbol lookup)
 * - filetime|{filePath} - File modification timestamps
 */
export class Storage {
  constructor(private objStore: ObjStore, private jsonlPath: string, private readonly debugOptions: DebugOptions, private verbose: boolean) {
  }

  /**
   * Store an import relationship in the index.
   * 
   * This creates an object representing a single import and adds it to multiple
   * groups to enable different types of queries:
   * - By importer file (all imports from a file)
   * - By exporter file (all files importing from a module)  
   * - By specific export name
   * - By cross-project relationships
   * 
   * @param importerPath Absolute path to the file doing the importing
   * @param importerTsConfig Path to tsconfig.json governing the importer
   * @param importIndex Index of this import within the importer file
   * @param exporterName Name being imported (e.g., 'UserService', 'default')
   * @param exporter Either resolved file path or unresolved import specifier
   */
  putImport(importerPath: string, importerTsConfig: string, importIndex: number, exporterName: string, exporter: Exporter) {
    const id = 'import|' + importerPath + '|' + importIndex;
    let groups = ['importPath|' + importerPath];
    if ('path' in exporter) {
      groups.push('exportPath|' + exporter.path);
      groups.push('export|' + exporter.path + '|' + exporterName);
      groups.push('projectUse|' + importerTsConfig + '|' + exporter.tsconfig);
      groups.push('symbolName|' + exporterName); // Add symbol name index for efficient symbol lookup
    } else {
      groups.push('exportSpec|' + exporter.spec);
    }
    this.objStore.put({ id, groups, exporter });
  }

  deleteImporterPath(importerPath: string) {
    const idsToDelete = this.objStore.getGroup('importPath|' + importerPath).map(obj => obj.id);
    for (const id of idsToDelete) {
      this.objStore.delete(id);
    }
  }

  getExporterPathsOfImport(importerPath: string): ExporterPath[] {
    const exporters = this.objStore.getGroup('importPath|' + importerPath);
    const result: ExporterPath[] = [];
    for (const obj of exporters) {
      const exporter = obj.exporter;
      if (isExporterPath(exporter)) {
        result.push(exporter);
      }
    }
    return result;
  }

  getImportersOfExport(exporterPath: string, exportedName: string): string[] {
    const importers = this.objStore.getGroup('export|' + exporterPath + '|' + exportedName);
    return importers.map(obj => obj.id.slice('export|'.length).split('|')[0]);
  }

  getImportersOfExportPath(exporterPath: string): Set<string> {
    const importers = this.objStore.getGroup('exportPath|' + exporterPath);
    const result = new Set<string>();
    for (const obj of importers) {
      const id = obj.id;
      const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));
      result.add(importerPath);
    }
    return result;
  }

  getProjectUses(fromTsconfig: string, toTsconfig: string): { importerPath: string, exporterPath: string }[] {
    const importers = this.objStore.getGroup('projectUse|' + fromTsconfig + '|' + toTsconfig);
    return importers.map(obj => {
      const id = obj.id;
      const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));
      const exporter = obj.exporter;
      if (exporter === null) {
        throw new Error('exporter is null');
      }
      if (typeof exporter !== 'object') {
        throw new Error('exporter is not an object');
      }
      if (!('path' in exporter)) {
        throw new Error('exporter has no path');
      }
      const exporterPath = exporter.path;
      if (typeof exporterPath !== 'string') {
        throw new Error('exporterPath is not a string');
      }
      return { importerPath, exporterPath };
    });
  }

  getProjectUsesWithSymbols(fromTsconfig: string, toTsconfig: string): { importerPath: string, exporterPath: string, symbolName: string }[] {
    const projectUseImports = this.objStore.getGroup('projectUse|' + fromTsconfig + '|' + toTsconfig);
    const result: { importerPath: string, exporterPath: string, symbolName: string }[] = [];
    
    for (const obj of projectUseImports) {
      const id = obj.id;
      const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));
      const exporter = obj.exporter;
      
      if (exporter === null || typeof exporter !== 'object' || !('path' in exporter)) {
        continue; // Skip invalid exporters
      }
      
      const exporterPath = exporter.path;
      if (typeof exporterPath !== 'string') {
        continue;
      }
      
      // Extract symbol name directly from this import object's groups
      const groups = obj.groups || [];
      for (const group of groups) {
        if (typeof group === 'string' && group.startsWith('export|' + exporterPath + '|')) {
          const symbolName = group.split('|')[2];
          if (symbolName) {
            result.push({ importerPath, exporterPath, symbolName });
          }
        }
      }
    }
    
    return result;
  }

  addFileTimestamp(file: string, mtimeMs: number) {
    this.objStore.put({ id: 'filetime|' + file, mtimeMs });
  }

  getFileTimestamp(file: string): number | undefined {
    const obj = this.objStore.get('filetime|' + file);
    const val = obj?.mtimeMs;
    if (typeof val === 'number') {
      return val;
    }
    return undefined;
  }

  putModuleNeeds(filePath: string, needs: { nodejs: boolean }) {
    this.objStore.put({ id: 'needs|' + filePath, needs });
  }

  putReExport(importerPath: string, reExportIndex: number, reExportName: string, reExport: ReExportInfo) {
    const id = 'reexport|' + importerPath + '|' + reExportIndex;
    const groups = ['reexportPath|' + importerPath, 'reexportName|' + reExportName];
    this.objStore.put({ id, groups, reExport });
  }

  getModuleNeeds(filePath: string): { nodejs: boolean } | undefined {
    const obj = this.objStore.get('needs|' + filePath);
    if (obj?.needs && typeof obj.needs === 'object' && 'nodejs' in obj.needs) {
      return obj.needs as { nodejs: boolean };
    }
    return undefined;
  }


  /**
   * Get all import objects for a specific symbol name.
   * Uses the symbolName group index for efficient lookup.
   * 
   * ⚠️  WARNING: This is a LOOSE search that matches symbol names across ALL modules.
   * Multiple unrelated symbols with the same name will be returned together.
   * 
   * SAFE FOR: Exploration, discovery, grep-like searching
   * NOT SAFE FOR: Refactoring, dependency analysis, code transformation
   * 
   * For refactoring operations, use fully qualified methods like:
   * - getImportersOfExport(exporterPath, exporterName) 
   * - Storage.export|{exporterPath}|{exporterName} groups
   */
  getSymbolImports(symbolName: string): ReadonlyArray<Obj> {
    return this.objStore.getGroup('symbolName|' + symbolName);
  }

  /**
   * Get all import objects from a specific importer file.
   * Uses the importPath group index for efficient lookup.
   */
  getImportsFromFile(importerPath: string): ReadonlyArray<Obj> {
    return this.objStore.getGroup('importPath|' + importerPath);
  }

  /**
   * Get all re-export objects from a specific file.
   * Uses the reexportPath group index for efficient lookup.
   */
  getReExportsFromFile(reExporterPath: string): ReadonlyArray<Obj> {
    return this.objStore.getGroup('reexportPath|' + reExporterPath);
  }

  /**
   * Get all re-export objects for a specific symbol name.
   * Uses the reexportName group index for efficient lookup.
   */
  getReExportsByName(reExportName: string): ReadonlyArray<Obj> {
    return this.objStore.getGroup('reexportName|' + reExportName);
  }

  /**
   * Get all re-export objects in the index.
   * This is used for finding all re-exports in the codebase.
   */
  getAllReExports(): ReadonlyArray<Obj & { reExport: ReExportInfo }> {
    const allReExports: Array<Obj & { reExport: ReExportInfo }> = [];
    for (const [id, obj] of this.objStore.objs) {
      if (id.startsWith('reexport|') && obj.reExport) {
        allReExports.push(obj as Obj & { reExport: ReExportInfo });
      }
    }
    return allReExports;
  }


  save() {
    saveObjStoreAsJsonl(this.jsonlPath, this.objStore, this.debugOptions, this.verbose);
  }
}

export function openStorage(debugOptions: DebugOptions, verbose: boolean) {
  const jsonlPath = '_objstore.jsonl';

  let objStore: ObjStore;
  if (existsSync(jsonlPath)) {
    objStore = loadObjStoreFromJsonl(jsonlPath, debugOptions);
  } else {
    objStore = new ObjStore(debugOptions);
  }

  const db = new Storage(objStore, jsonlPath, debugOptions, verbose);
  return db;
}