import { resolve } from 'path';
import { CliError } from './errors';

export interface CompilerOptions {
  paths: Record<string, string[]>;
  baseUrl: string | null;
  rootDir: string | null;
}

/**
 * Strip a TypeScript extension (.ts, .mts, .cts) from a module path.
 * Returns the path unchanged if it has no recognized TS extension.
 */
export function modulePathSpec(modulePath: string): string {
  if (modulePath.endsWith('.mts') || modulePath.endsWith('.cts')) {
    return modulePath.slice(0, -4);
  }
  if (modulePath.endsWith('.ts')) {
    return modulePath.slice(0, -3);
  }
  return modulePath;
}

/**
 * Validate that a single path entry from a tsconfig paths mapping ends with
 * "/*" and return its prefix (without the trailing "*").
 */
export function extractPathPrefix(alias: string, paths: string[]): string {
  if (paths.length !== 1) {
    throw new CliError(
      `Alias "${alias}" has ${paths.length} path(s); exactly 1 is required`,
      {},
    );
  }
  // biome-ignore lint/style/noNonNullAssertion: Length guard (paths.length === 1) guarantees at(0) is defined.
  const path = paths.at(0)!;
  if (!path.endsWith('/*')) {
    throw new CliError(
      `Alias "${alias}" path "${path}" does not end with "/*"`,
      {},
    );
  }
  return path.slice(0, -1);
}

/**
 * Convert an absolute module path to its tsconfig paths alias (e.g. `@src/foo`),
 * or return null if no alias mapping applies.
 */
export function modulePathToImportSpecAlias(
  compilerOptions: CompilerOptions,
  tsconfigDir: string,
  modulePath: string,
): string | null {
  const pathWithoutExt = modulePathSpec(modulePath);

  const entries: [string, string[]][] = [
    ['./*', [(compilerOptions.rootDir ?? '.') + '/*']],
    ...Object.entries(compilerOptions.paths),
  ];

  for (const [alias, paths] of entries) {
    const pathPrefix = extractPathPrefix(alias, paths);
    let absPathPrefix = resolve(tsconfigDir, pathPrefix) + '/';
    if (!pathWithoutExt.startsWith(absPathPrefix)) {
      absPathPrefix =
        resolve(tsconfigDir, compilerOptions.baseUrl ?? '.', pathPrefix) + '/';
      if (!pathWithoutExt.startsWith(absPathPrefix)) {
        continue;
      }
    }

    const aliasPrefix = alias.slice(0, -1);
    const relPath = aliasPrefix + pathWithoutExt.slice(absPathPrefix.length);
    return relPath;
  }
  return null;
}
