import { dirname, relative, resolve } from "path";
import { getTsconfigPathForFile } from "./project";
import { CliError } from "./errors";
import { FileSystem } from "./filesystem";
import { isPathWithinDirectory } from "./pathUtils";
import { ts } from "ts-morph";
import { CompilerOptions, extractPathPrefix, modulePathSpec, modulePathToImportSpecAlias } from "./importSpec";

export async function resolveSpecWithCompilerOptions(
  compilerOptions: CompilerOptions,
  tsconfigDir: string,
  importSpec: string,
  tsFilePath: string,
  fileSystem: FileSystem,
): Promise<string | null> {
  if (importSpec.startsWith('.')) {
    return resolveSourceFile(importSpec, dirname(tsFilePath), fileSystem);
  }

  return importSpecAliasToModulePath(
    compilerOptions,
    tsconfigDir,
    importSpec,
    fileSystem,
  );
}

export async function resolveImportSpec(
  repoRoot: string,
  tsFilePath: string,
  importSpec: string,
  fileSystem: FileSystem,
): Promise<string | null> {
  const { compilerOptions, tsconfigDir } = await loadTsconfigOptions(
    repoRoot,
    tsFilePath,
    fileSystem,
  );
  return resolveSpecWithCompilerOptions(
    compilerOptions,
    tsconfigDir,
    importSpec,
    tsFilePath,
    fileSystem,
  );
}

/**
 * Read and parse a tsconfig.json file, extracting paths, baseUrl, and rootDir.
 *
 * Validates that all path-mapping aliases end with "/*".
 * @throws {@link CliError} if the file is invalid or alias format is unsupported.
 */
export async function getCompilerOptions(
  tsconfigFile: string,
  fileSystem: FileSystem,
): Promise<CompilerOptions> {
  const tsconfigContent = await fileSystem.readFile(tsconfigFile);
  const tsconfig = ts.parseConfigFileTextToJson(tsconfigFile, tsconfigContent);
  if (tsconfig.error) {
    const msg = ts.flattenDiagnosticMessageText(
      tsconfig.error.messageText,
      '\n',
    );
    throw new CliError(`Failed to read tsconfig: ${msg}`, {});
  }
  const compilerOptions = tsconfig.config.compilerOptions;
  const paths = compilerOptions?.paths ?? {};
  for (const alias of Object.keys(paths)) {
    if (!alias.endsWith('/*')) {
      throw new CliError(`Alias "${alias}" does not end with "/*"`, {});
    }
  }
  const baseUrl = compilerOptions?.baseUrl || null;
  const rootDir = compilerOptions?.rootDir || null;

  return {
    paths,
    baseUrl,
    rootDir,
  };
}

async function resolveSourceFile(
  spec: string,
  baseDir: string,
  fileSystem: FileSystem,
): Promise<string> {
  const absSpec = resolve(baseDir, spec);

  if (!await fileSystem.exists(absSpec)) {
    // Path does not exist — try to guess the source file
    if (absSpec.endsWith('.js')) {
      return absSpec.slice(0, -3) + '.ts';
    }
    if (absSpec.endsWith('.mjs')) {
      return absSpec.slice(0, -4) + '.mts';
    }
    if (absSpec.endsWith('.cjs')) {
      return absSpec.slice(0, -4) + '.cts';
    }
    return absSpec + '.ts';
  }

  const stat = await fileSystem.stat(absSpec);
  if (!stat.isFile()) {
    return absSpec + '/index.ts';
  }
  return absSpec;
}

async function importSpecAliasToModulePath(
  compilerOptions: CompilerOptions,
  tsconfigDir: string,
  importSpec: string,
  fileSystem: FileSystem,
): Promise<string | null> {
  for (const [alias, paths] of Object.entries(compilerOptions.paths)) {
    const aliasPrefix = alias.slice(0, -1);
    if (!importSpec.startsWith(aliasPrefix)) {
      continue;
    }
    const pathPrefix = extractPathPrefix(alias, paths);
    const relPath = pathPrefix + importSpec.slice(aliasPrefix.length);
    const baseDir = compilerOptions.baseUrl
      ? resolve(tsconfigDir, compilerOptions.baseUrl)
      : tsconfigDir;
    return resolveSourceFile(relPath, baseDir, fileSystem);
  }
  return null;
}

/**
 * Convert an absolute module file path to an import spec string.
 *
 * Returns a path alias (e.g. `@src/foo`) when the module falls under a
 * tsconfig paths mapping, a relative path (e.g. `./foo`) when both the
 * module and importer share the same tsconfig, or null when the module
 * lies outside the tsconfig directory.
 *
 * @param modulePath - Absolute path to the source file (e.g. `/repo/src/foo.ts`).
 */
export async function resolveImportSpecAlias(
  repoRoot: string,
  tsFilePath: string,
  modulePath: string,
  fileSystem: FileSystem,
): Promise<string | null> {
  const { compilerOptions, tsconfigDir } = await loadTsconfigOptions(
    repoRoot,
    tsFilePath,
    fileSystem,
  );
  const alias = modulePathToImportSpecAlias(
    compilerOptions,
    tsconfigDir,
    modulePath,
  );
  if (alias) {
    return alias;
  }
  if (
    isPathWithinDirectory(modulePath, tsconfigDir) &&
    isPathWithinDirectory(tsFilePath, tsconfigDir)
  ) {
    const relPath = relative(dirname(tsFilePath), modulePathSpec(modulePath));
    if (relPath === '') {
      return null;
    }
    return relPath.startsWith('.') ? relPath : './' + relPath;
  }
  return null;
}

async function loadTsconfigOptions(
  repoRoot: string,
  tsFilePath: string,
  fileSystem: FileSystem,
): Promise<{ compilerOptions: CompilerOptions; tsconfigDir: string }> {
  const tsconfigPath = await getTsconfigPathForFile(
    repoRoot,
    tsFilePath,
    fileSystem,
  );
  if (!tsconfigPath) {
    throw new CliError('No tsconfig found', {});
  }
  const tsconfigDir = dirname(tsconfigPath);
  return {
    compilerOptions: await getCompilerOptions(tsconfigPath, fileSystem),
    tsconfigDir,
  };
}
