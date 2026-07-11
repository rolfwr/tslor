import { ReExport, StaticModuleInfo, parseModule } from "./staticAnalysis";
import { getCompilerOptions, resolveSpecWithCompilerOptions } from "./resolveImport";
import { FileSystem } from "./filesystem";
import { getTsconfigPathForFile } from "./project";
import { loadSourceFileForAnalysis } from "./loadSourceFile";
import { reThrowAsCliError } from "./errors";
import { CompilerOptions } from "./importSpec";
import { dirname } from "path";

export interface ModuleInfo {
  path: string;
  repoRoot: string;
  tsconfig: string;
  imports: NamedImport[];
  unresolvedImports: ExternalImport[];
  sideEffectImports: SideEffectImport[];
  reExports: ReExport[];
  /**
   * Over-approximated set of ambient name references (syntactic pass minus
   * locally-bound names). May contain false positives (leaked function-locals);
   * the exact tier (sealed binder) prunes them.
   */
  ambientNames: string[];
}


async function resolveImportSpecs(
  staticModuleInfo: StaticModuleInfo,
  getCompilerOptionsFn: (tsconfig: string) => Promise<CompilerOptions>,
  importerTsConfig: string,
  tsFilePath: string,
  fileSystem: FileSystem,
): Promise<Map<string, string>> {
  const importSpecs = new Set<string>();
  for (const unresolved of staticModuleInfo.unresolvedExportsByImportNames.values()) {
    importSpecs.add(unresolved.moduleSpec);
  }
  for (const reExport of staticModuleInfo.reExports) {
    importSpecs.add(reExport.moduleSpec);
  }
  for (const imp of staticModuleInfo.imports) {
    importSpecs.add(imp.moduleSpec);
  }

  if (importSpecs.size === 0) {
    return new Map();
  }

  const compilerOptions = await getCompilerOptionsFn(importerTsConfig);
  const resolvedPathsBySpec = new Map<string, string>();
  for (const spec of importSpecs) {
    const resolvedPath = await resolveSpecWithCompilerOptions(
      compilerOptions,
      dirname(importerTsConfig),
      spec,
      tsFilePath,
      fileSystem,
    );
    if (resolvedPath) {
      resolvedPathsBySpec.set(spec, resolvedPath);
    }
  }
  return resolvedPathsBySpec;
}


function buildModuleInfo(
  tsFilePath: string,
  repoRoot: string,
  tsconfigPath: string,
  staticModuleInfo: StaticModuleInfo,
  resolvedPathsBySpec: Map<string, string>,
): ModuleInfo {
  const imports: NamedImport[] = [];
  const unresolvedImports: ExternalImport[] = [];
  const sideEffectImports: SideEffectImport[] = [];

  for (const unresolved of staticModuleInfo.unresolvedExportsByImportNames.values()) {
    const resolvedPath = resolvedPathsBySpec.get(unresolved.moduleSpec);
    if (resolvedPath) {
      imports.push({
        type: 'NamedImport',
        path: resolvedPath,
        name: unresolved.name,
      });
    } else {
      unresolvedImports.push({
        type: 'ExternalImport',
        moduleSpecifier: unresolved.moduleSpec,
        name: unresolved.name,
      });
    }
  }

  /*
    Side-effect imports (`import 'fs'`) have empty `names` in
    staticModuleInfo.imports and are tracked as SideEffectImport
    for dependency tracking. Unresolved external side-effects are
    omitted — they have no symbol to index.
  */
  for (const imp of staticModuleInfo.imports) {
    if (imp.names.length === 0) {
      const resolvedPath = resolvedPathsBySpec.get(imp.moduleSpec);
      if (resolvedPath) {
        sideEffectImports.push({
          type: 'SideEffectImport',
          path: resolvedPath,
        });
      }
    }
  }

  return {
    path: tsFilePath,
    repoRoot,
    tsconfig: tsconfigPath,
    imports,
    unresolvedImports,
    sideEffectImports,
    reExports: staticModuleInfo.reExports.map(function (reExport) {
      const resolvedPath = resolvedPathsBySpec.get(reExport.moduleSpec);
      if (resolvedPath) {
        return { ...reExport, resolvedPath };
      }
      return reExport;
    }),
    ambientNames: [...staticModuleInfo.ambientNames],
  };
}


async function inspectModuleCore(
  repoRoot: string,
  tsFilePath: string,
  getTsconfig: () => Promise<string | null>,
  getCompilerOptionsFn: (tsconfig: string) => Promise<CompilerOptions>,
  fileSystem: FileSystem,
): Promise<ModuleInfo | null> {
  try {
    const importerTsConfig = await getTsconfig();
    if (!importerTsConfig) {
      return null;
    }
    const sourceFile = await loadSourceFileForAnalysis(tsFilePath, fileSystem);
    const staticModuleInfo = parseModule(sourceFile);
    const resolvedPathsBySpec = await resolveImportSpecs(
      staticModuleInfo,
      getCompilerOptionsFn,
      importerTsConfig,
      tsFilePath,
      fileSystem,
    );
    return buildModuleInfo(
      tsFilePath,
      repoRoot,
      importerTsConfig,
      staticModuleInfo,
      resolvedPathsBySpec,
    );
  } catch (error) {
    reThrowAsCliError(error, `Failed to inspect module ${tsFilePath}`, 'expected');
  }
}


/**
 * Parse and resolve a single module's imports, re-exports, and ambient
 * name references.
 *
 * @returns ModuleInfo on success, or null when no tsconfig is found for the
 *          file. Throws {@link CliError} on I/O or parse failures.
 */
export async function inspectModule(
  repoRoot: string,
  tsFilePath: string,
  fileSystem: FileSystem,
): Promise<ModuleInfo | null> {
  return inspectModuleCore(
    repoRoot,
    tsFilePath,
    () => getTsconfigPathForFile(repoRoot, tsFilePath, fileSystem),
    (tsconfig) => getCompilerOptions(tsconfig, fileSystem),
    fileSystem,
  );
}


/**
 * Creates a stateful module inspector that caches tsconfig path lookups
 * (by directory) and compiler options (by tsconfig path) across repeated
 * calls. This eliminates the redundant I/O performed on every import in
 * every file — the dominant overhead after TypeScript AST parsing itself.
 *
 * Intended for use in worker threads, where one inspector is created per
 * worker. Files are processed sequentially (never concurrently), so the
 * caches are safe.
 */
export function createModuleInspector(
  fileSystem: FileSystem,
): (repoRoot: string, tsFilePath: string) => Promise<ModuleInfo | null> {
  const tsconfigPathByDir = new Map<string, string | null>();
  const compilerOptionsByTsconfig = new Map<string, CompilerOptions>();

  async function cachedGetTsconfigPath(
    repoRoot: string,
    filePath: string,
  ): Promise<string | null> {
    const dir = dirname(filePath);
    const cacheKey = `${repoRoot}\0${dir}`;
    const cached = tsconfigPathByDir.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const result = await getTsconfigPathForFile(repoRoot, filePath, fileSystem);
    tsconfigPathByDir.set(cacheKey, result);
    return result;
  }

  async function cachedGetCompilerOptions(
    tsconfigFile: string,
  ): Promise<CompilerOptions> {
    const cached = compilerOptionsByTsconfig.get(tsconfigFile);
    if (cached !== undefined) {
      return cached;
    }
    const result = await getCompilerOptions(tsconfigFile, fileSystem);
    compilerOptionsByTsconfig.set(tsconfigFile, result);
    return result;
  }

  return function inspect(
    repoRoot: string,
    tsFilePath: string,
  ): Promise<ModuleInfo | null> {
    return inspectModuleCore(
      repoRoot,
      tsFilePath,
      () => cachedGetTsconfigPath(repoRoot, tsFilePath),
      cachedGetCompilerOptions,
      fileSystem,
    );
  };
}


/** Import of a named symbol from another local module. */
export interface NamedImport {
  type: 'NamedImport';
  path: string;
  name: string;
}


/**
 * Side-effect import (`import 'module'`) with no symbols imported.
 * Tracked separately from named imports so dependency relationships
 * are preserved without polluting symbol-name indices.
 */
export interface SideEffectImport {
  type: 'SideEffectImport';
  path: string;
}


/**
 * Import of a named symbol from an external (unresolved) module.
 * The original module specifier is preserved rather than a resolved path.
 */
export interface ExternalImport {
  type: 'ExternalImport';
  moduleSpecifier: string;
  name: string;
}
