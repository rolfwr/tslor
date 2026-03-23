import { resolve } from 'path';

export interface CompilerOptions {
  paths: Record<string, string[]>;
  baseUrl: string | null;
  rootDir: string | null;
}

export function modulePathSpec(modulePath: string) {
  return modulePath.endsWith('.ts') ? modulePath.slice(0, -3) : modulePath;
}

export function modulePathToImportSpecAlias(compilerOptions: CompilerOptions, tsconfigDir: string, modulePath: string) {
  const pathWithoutExt = modulePathSpec(modulePath);

  const entries = Object.entries(compilerOptions.paths);
  entries.splice(0, 0, ['./*', [(compilerOptions.rootDir ?? '.') + '/*']]);

  for (const [alias, paths] of Object.entries(compilerOptions.paths)) {
    if (paths.length !== 1) {
      throw new Error('Unsupported alias path count');
    }
    const path = paths[0];
    if (!path.endsWith('/*')) {
      throw new Error('Unsupported alias path');
    }

    const pathPrefix = path.slice(0, -1);
    let absPathPrefix = resolve(tsconfigDir, pathPrefix) + '/';
    if (!pathWithoutExt.startsWith(absPathPrefix)) {
      absPathPrefix = resolve(tsconfigDir, compilerOptions.baseUrl ?? '.', pathPrefix) + '/';  
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

