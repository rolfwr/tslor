import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { invariant } from './invariant';
import {
  loadObjStoreFromJsonl,
  ObjStore,
  saveObjStoreAsJsonl,
  DebugOptions,
  Obj,
} from './objstore';
import { normalizePath } from './pathUtils';

/** File name of the object store JSONL database */
const OBJSTORE_FILENAME = '_objstore.jsonl';

/**
 * Reference to a module with its governing tsconfig.
 * Used for both forward (exporter) and reverse (importer) dependency queries.
 */
export interface ExporterPath {
  path: string;
  tsconfig: string;
}

export interface ExporterSpec {
  spec: string;
}

export interface ReExportInfo {
  moduleSpec: string;
  isTypeOnly: boolean;
  resolvedPath?: string;
}

/**
 * A re-export entry extracted from the index.
 */
export interface ReExportItem {
  reExporterPath: string;
  symbolName: string;
  originalModuleSpec: string;
  isTypeOnly: boolean;
  resolvedPath?: string;
}

export type Exporter = ExporterPath | ExporterSpec;

export interface ObjWithExporterPath extends Obj {
  exporter: ExporterPath;
}

/**
 * Type guard for Obj instances with a resolved exporter (has path + tsconfig).
 */
export function isObjWithExporterPath(
  obj: unknown,
): obj is ObjWithExporterPath {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  if (!('exporter' in obj)) {
    return false;
  }
  const exporter = obj['exporter'];
  if (typeof exporter !== 'object' || exporter === null) {
    return false;
  }
  return (
    'path' in exporter &&
    typeof exporter.path === 'string' &&
    'tsconfig' in exporter &&
    typeof exporter.tsconfig === 'string'
  );
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

function isModuleNeeds(value: unknown): value is { nodejs: boolean } {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (!('nodejs' in value)) {
    return false;
  }
  return typeof value.nodejs === 'boolean';
}

function isReExportObj(obj: Obj): obj is Obj & { reExport: ReExportInfo } {
  const reExport = obj.reExport;
  if (reExport === null || typeof reExport !== 'object') {
    return false;
  }
  if (!('moduleSpec' in reExport) || typeof reExport.moduleSpec !== 'string') {
    return false;
  }
  if (!('isTypeOnly' in reExport) || typeof reExport.isTypeOnly !== 'boolean') {
    return false;
  }
  return true;
}

interface StorageOptions {
  jsonlPath: string;
  verbose: boolean;
  inMemory: boolean;
}

export class Storage {
  /** Tracks whether the store has been modified since last load/save */
  private isDirty = false;

  constructor(
    private objStore: ObjStore,
    private options: StorageOptions,
  ) {}

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
   * @param importerPath Path to the file doing the importing (normalized internally)
   * @param importerTsConfig Path to tsconfig.json governing the importer (normalized internally)
   * @param importIndex Index of this import within the importer file
   * @param exporterName Name being imported (e.g., 'UserService', 'default')
   * @param exporter Either resolved file path (normalized internally) or unresolved import specifier
   */
  putImport(
    importerPath: string,
    importerTsConfig: string,
    importIndex: number,
    exporterName: string,
    exporter: Exporter,
  ) {
    this.isDirty = true;
    const normalizedImporter = normalizePath(importerPath);
    const normalizedImporterTsconfig = normalizePath(importerTsConfig);
    const id = 'import|' + normalizedImporter + '|' + importIndex;
    const groups = ['importPath|' + normalizedImporter];
    if ('path' in exporter) {
      const normalizedExporterPath = normalizePath(exporter.path);
      const normalizedExporterTsconfig = normalizePath(exporter.tsconfig);
      groups.push('exportPath|' + normalizedExporterPath);
      groups.push('export|' + normalizedExporterPath + '|' + exporterName);
      groups.push(
        'projectUse|' +
          normalizedImporterTsconfig +
          '|' +
          normalizedExporterTsconfig,
      );
      groups.push('symbolName|' + exporterName);
    } else {
      groups.push('exportSpec|' + exporter.spec);
    }
    this.objStore.put({ id, groups, exporter });
  }

  deleteImporterPath(importerPath: string) {
    const idsToDelete = this.objStore
      .getGroup('importPath|' + normalizePath(importerPath))
      .map((obj) => obj.id);
    if (idsToDelete.length === 0) {
      return;
    }
    this.isDirty = true;
    for (const id of idsToDelete) {
      this.objStore.delete(id);
    }
  }

  getExporterPathsOfImport(importerPath: string): ExporterPath[] {
    const exporters = this.objStore.getGroup(
      'importPath|' + normalizePath(importerPath),
    );
    const result: ExporterPath[] = [];
    for (const obj of exporters) {
      if (isObjWithExporterPath(obj)) {
        result.push(obj.exporter);
      }
    }
    return result;
  }

  getImportersOfExport(exporterPath: string, exportedName: string): string[] {
    const importers = this.objStore.getGroup(
      'export|' + normalizePath(exporterPath) + '|' + exportedName,
    );
    return importers
      .map((obj) => obj.id.slice('export|'.length).split('|').at(0))
      .filter((p): p is string => p !== undefined);
  }

  getImportersOfExportPath(exporterPath: string): Set<string> {
    const importers = this.objStore.getGroup(
      'exportPath|' + normalizePath(exporterPath),
    );
    const result = new Set<string>();
    for (const obj of importers) {
      const id = obj.id;
      const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));
      result.add(importerPath);
    }
    return result;
  }

  /**
   * Get all modules that import the given module, along with their tsconfig.
   * Used for reverse-dependency walking with project scope filtering.
   *
   * Records without tsconfig metadata (no `projectUse` group) are skipped.
   */
  getReverseDependencies(exporterPath: string): ExporterPath[] {
    const importRecords = this.objStore.getGroup(
      'exportPath|' + normalizePath(exporterPath),
    );
    const seen = new Set<string>();
    const result: ExporterPath[] = [];

    for (const obj of importRecords) {
      const id = obj.id;
      const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));
      if (seen.has(importerPath)) {
        continue;
      }
      seen.add(importerPath);

      const importerTsconfig = this.extractImporterTsconfig(obj.groups);
      if (importerTsconfig === undefined) {
        // Skip imports of unresolved specifiers (e.g., third-party packages)
        continue;
      }
      result.push({ path: importerPath, tsconfig: importerTsconfig });
    }

    return result;
  }

  /**
   * Extract the importer's tsconfig from a `projectUse` group.
   *
   * Returns undefined when the object has no `projectUse|{from}|{to}` group,
   * which happens for imports of unresolved specifiers (e.g., third-party packages).
   */
  private extractImporterTsconfig(
    groups: string[] | undefined,
  ): string | undefined {
    if (!groups) {
      return undefined;
    }
    for (const group of groups) {
      if (group.startsWith('projectUse|')) {
        const parts = group.split('|');
        if (parts.length >= 3) {
          return parts[1];
        }
      }
    }
    return undefined;
  }

  getProjectUses(
    fromTsconfig: string,
    toTsconfig: string,
  ): { importerPath: string; exporterPath: string }[] {
    const importers = this.objStore.getGroup(
      'projectUse|' +
        normalizePath(fromTsconfig) +
        '|' +
        normalizePath(toTsconfig),
    );
    return importers.map((obj) => {
      const id = obj.id;
      const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));
      const exporterPath = this.extractExporterPath(obj);
      invariant(exporterPath, 'projectUse record missing exporter path');
      return { importerPath, exporterPath };
    });
  }

  getProjectUsesWithSymbols(
    fromTsconfig: string,
    toTsconfig: string,
  ): { importerPath: string; exporterPath: string; symbolName: string }[] {
    const projectUseImports = this.objStore.getGroup(
      'projectUse|' +
        normalizePath(fromTsconfig) +
        '|' +
        normalizePath(toTsconfig),
    );
    const result: {
      importerPath: string;
      exporterPath: string;
      symbolName: string;
    }[] = [];

    for (const obj of projectUseImports) {
      const importerPath = obj.id.slice(
        'import|'.length,
        obj.id.lastIndexOf('|'),
      );
      const exporterPath = this.extractExporterPath(obj);
      invariant(exporterPath, 'projectUse record missing exporter path');
      for (const symbolName of this.extractSymbolNamesFromGroups(
        obj.groups,
        exporterPath,
      )) {
        result.push({ importerPath, exporterPath, symbolName });
      }
    }

    return result;
  }

  private extractExporterPath(obj: Readonly<Obj>): string | undefined {
    if (!isObjWithExporterPath(obj)) {
      return undefined;
    }
    return obj.exporter.path;
  }

  private extractSymbolNamesFromGroups(
    groups: string[] | undefined,
    exporterPath: string,
  ): string[] {
    const prefix = 'export|' + exporterPath + '|';
    if (!groups) {
      return [];
    }
    return groups
      .filter((group) => group.startsWith(prefix))
      .map((group) => group.split('|')[2])
      .filter((name): name is string => name !== undefined);
  }

  addFileTimestamp(file: string, mtimeMs: number) {
    this.isDirty = true;
    this.objStore.put({ id: 'filetime|' + normalizePath(file), mtimeMs });
  }

  getFileTimestamp(file: string): number | undefined {
    const obj = this.objStore.get('filetime|' + normalizePath(file));
    const val = obj?.mtimeMs;
    if (typeof val === 'number') {
      return val;
    }
    return undefined;
  }

  putModuleNeeds(filePath: string, needs: { nodejs: boolean }) {
    this.isDirty = true;
    this.objStore.put({ id: 'needs|' + normalizePath(filePath), needs });
  }

  putReExport(
    importerPath: string,
    reExportIndex: number,
    reExportName: string,
    reExport: ReExportInfo,
  ) {
    this.isDirty = true;
    const normalizedImporter = normalizePath(importerPath);
    const id = 'reexport|' + normalizedImporter + '|' + reExportIndex;
    const groups = [
      'reexportPath|' + normalizedImporter,
      'reexportName|' + reExportName,
    ];
    this.objStore.put({ id, groups, reExport });
  }

  getModuleNeeds(filePath: string): { nodejs: boolean } | undefined {
    const obj = this.objStore.get('needs|' + normalizePath(filePath));
    const needs = obj?.needs;
    if (isModuleNeeds(needs)) {
      return needs;
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
   * - export|{exporterPath}|{exporterName} groups
   */
  getSymbolImports(symbolName: string): ReadonlyArray<Obj> {
    return this.objStore.getGroup('symbolName|' + symbolName);
  }

  /**
   * Get all import objects from a specific importer file.
   * Uses the importPath group index for efficient lookup.
   */
  getImportsFromFile(importerPath: string): ReadonlyArray<Obj> {
    return this.objStore.getGroup('importPath|' + normalizePath(importerPath));
  }

  /**
   * Get all re-export objects from a specific file.
   * Uses the reexportPath group index for efficient lookup.
   */
  getReExportsFromFile(reExporterPath: string): ReadonlyArray<Obj> {
    return this.objStore.getGroup(
      'reexportPath|' + normalizePath(reExporterPath),
    );
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
      if (id.startsWith('reexport|') && isReExportObj(obj)) {
        allReExports.push(obj);
      }
    }
    return allReExports;
  }

  /**
   * Extract all re-export entries from the index.
   *
   * Parses the internal index objects into structured re-export records.
   */
  findAllReExports(): ReExportItem[] {
    const reExports: ReExportItem[] = [];

    for (const reExportObj of this.getAllReExports()) {
      const nameGroup = reExportObj.groups?.find((g) =>
        g.startsWith('reexportName|'),
      );
      invariant(nameGroup, 'reexport object missing reexportName group');
      const symbolName = nameGroup.slice('reexportName|'.length);
      const reExporterPath = reExportObj.id.slice(
        'reexport|'.length,
        reExportObj.id.lastIndexOf('|'),
      );
      reExports.push({
        reExporterPath,
        symbolName,
        originalModuleSpec: reExportObj.reExport.moduleSpec,
        isTypeOnly: reExportObj.reExport.isTypeOnly,
        ...(reExportObj.reExport.resolvedPath !== undefined && {
          resolvedPath: reExportObj.reExport.resolvedPath,
        }),
      });
    }

    return reExports;
  }

  save() {
    if (this.options.inMemory) {
      return;
    }
    if (!this.isDirty) {
      return;
    }
    saveObjStoreAsJsonl(
      this.options.jsonlPath,
      this.objStore,
      writeFileSync,
      this.options.verbose ? console.error : undefined,
    );
    this.isDirty = false;
  }
}

/**
 * Configuration for opening a storage instance.
 */
export interface OpenStorageOptions {
  /** When true, log save progress to stderr */
  verbose: boolean;
  /** When true, delete the existing database file before opening */
  fresh?: boolean;
  /**
   * Directory containing the database file. When omitted,
   * the database file is placed relative to the current working directory.
   */
  basePath?: string;
  /** When true, the store is in-memory only and `save()` is a no-op */
  inMemory: boolean;
}

/**
 * Open or create the object store database.
 *
 * @param debugOptions Debug tracing configuration.
 * @param options Storage configuration options.
 * @returns Storage instance backed by the database file.
 */
export function openStorage(
  debugOptions: DebugOptions,
  options: OpenStorageOptions,
) {
  const { verbose, fresh = false, basePath, inMemory } = options;
  const jsonlPath = basePath
    ? join(basePath, OBJSTORE_FILENAME)
    : OBJSTORE_FILENAME;

  if (fresh && existsSync(jsonlPath)) {
    unlinkSync(jsonlPath);
  }

  const objStore = existsSync(jsonlPath)
    ? loadObjStoreFromJsonl(jsonlPath, debugOptions)
    : new ObjStore(debugOptions);

  return new Storage(objStore, { jsonlPath, verbose, inMemory });
}
