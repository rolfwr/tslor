import { readFileSync } from 'fs';

/**
 * Debug options for ObjStore tracing.
 */
export interface DebugOptions {
  traceId: string | null;
}

/**
 * Object stored in the TSLOR index system.
 *
 * Objects can belong to multiple named indexes to enable efficient queries.
 * This is similar to database secondary indexes - each object can be found
 * via multiple index keys. For example, an import statement might have indexes:
 * - `import|${importerPath}|${index}` (primary key)
 * - `importPath|${importerPath}` (secondary index: all imports from file)
 */
export interface Obj {
  id: string;
  groups?: string[]; // TODO: Consider renaming from 'groups' to 'indexes'
  [x: string | number | symbol]: unknown;
}

/**
 * JSONL-based object store with secondary indexing for efficient queries.
 *
 * This implements a database-like storage system where objects can belong to
 * multiple named indexes (called "groups" in the code for historical reasons).
 * Similar to SQL secondary indexes, this enables efficient lookups like
 * "all imports from file X" or "all exports of name Y".
 *
 * Design rationale: JSONL provides better performance than SQLite for this
 * workload because we primarily need bulk loading and index-based queries
 * rather than complex relational operations.
 *
 * Performance characteristics:
 * - O(1) object retrieval by ID
 * - O(1) index queries (e.g., "all imports from file")
 * - O(n) bulk loading from JSONL
 * - Memory usage: entire index kept in memory for fast access
 */
export class ObjStore {
  /** Primary storage: object ID → object */
  objs: Map<string, Obj> = new Map();

  /** Secondary indexes: index key → (object ID → object) */
  groups: Map<string, Map<string, Obj>> = new Map(); // TODO: Rename to 'indexes'

  /** Debug trace ID for troubleshooting */
  private readonly traceId: string | null;

  constructor(debugOptions: DebugOptions) {
    this.traceId = debugOptions.traceId;
  }

  /**
   * Store an object and add it to all specified indexes.
   *
   * This is the primary method for adding data to the index. Each object
   * is stored by its ID and also added to all secondary indexes it belongs to,
   * enabling both direct lookups and index-based queries.
   */
  put(obj: Obj) {
    if (this.traceId && obj.id === this.traceId) {
      console.log('PUT', obj);
    }
    this.objs.set(obj.id, obj);
    if (obj.groups) {
      // Note: property still named 'groups' for compatibility
      for (const indexKey of obj.groups) {
        let indexMap = this.groups.get(indexKey);
        if (!indexMap) {
          indexMap = new Map();
          this.groups.set(indexKey, indexMap);
        }
        indexMap.set(obj.id, obj);
      }
    }
  }

  get(id: string): Readonly<Obj> | undefined {
    if (this.traceId && id === this.traceId) {
      console.log('GET', id);
    }
    return this.objs.get(id);
  }

  delete(id: string): boolean {
    if (this.traceId && id === this.traceId) {
      console.log('DELETE', id);
    }
    const obj = this.objs.get(id);
    if (!obj) {
      return false;
    }
    this.objs.delete(id);
    if (obj.groups) {
      for (const group of obj.groups) {
        const groupMap = this.groups.get(group);
        if (groupMap) {
          groupMap.delete(id);
        }
      }
    }
    return true;
  }

  /**
   * Get all objects belonging to a specific group.
   *
   * This is the key method that enables efficient queries like:
   * - getGroup('importPath|/src/app.ts') → all imports from app.ts
   * - getGroup('export|/src/utils.ts|helper') → specific export
   *
   * @param group Group name (e.g., 'importPath|/src/app.ts')
   * @returns Array of all objects in the group
   */
  getGroup(group: string): ReadonlyArray<Obj> {
    const groupMap = this.groups.get(group);
    if (!groupMap) {
      return [];
    }
    return Array.from(groupMap.values());
  }

  allObjs(): ReadonlyArray<Obj> {
    return Array.from(this.objs.values());
  }

  clear() {
    this.objs.clear();
    this.groups.clear();
  }
}

export function saveObjStoreAsJsonl(
  filename: string,
  store: ObjStore,
  writeFn: (path: string, data: string) => void,
  onVerbose?: (message: string) => void,
) {
  const objs = store.allObjs();
  writeFn(filename, objs.map((obj) => JSON.stringify(obj)).join('\n'));
  if (onVerbose) {
    onVerbose('Saved ' + objs.length + ' entities to ' + filename);
  }
}

export function loadObjStoreFromJsonl(
  filename: string,
  debugOptions: DebugOptions,
): ObjStore {
  // RATIONALE: JSON parsing boundary
  // ast-grep-ignore: no-type-assertion
  const data = readFileSync(filename, 'utf8')
    .split('\n')
    .map((line) => JSON.parse(line)) as Obj[];
  const store = new ObjStore(debugOptions);
  for (const obj of data) {
    store.put(obj);
  }
  return store;
}
