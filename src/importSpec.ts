import { resolve } from 'path';
import { CliError } from './errors';

export interface CompilerOptions {
  paths: Record<string, string[]>;
  baseUrl: string | null;
  rootDir: string | null;
}

export function modulePathSpec(modulePath: string) {
  return modulePath.endsWith('.ts') ? modulePath.slice(0, -3) : modulePath;
}

export function modulePathToImportSpecAlias(
  compilerOptions: CompilerOptions,
  tsconfigDir: string,
  modulePath: string,
) {
  const pathWithoutExt = modulePathSpec(modulePath);

  const entries: [string, string[]][] = [
    ['./*', [(compilerOptions.rootDir ?? '.') + '/*']],
    ...Object.entries(compilerOptions.paths),
  ];

  for (const [alias, paths] of entries) {
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

    const pathPrefix = path.slice(0, -1);
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
