import { isAbsolute, resolve } from 'path';
import { FileSystem } from './filesystem';
import { updateStorage } from './indexing';
import { DebugOptions } from './objstore';
import { isPathWithinDirectory } from './pathUtils';
import { findGitRepoRoot } from './project';
import { isObjWithExporterPath, openStorage } from './storage';

function collectExporterPaths(
  symbolImports: ReadonlyArray<import('./objstore').Obj>,
  absoluteProjectPath: string,
): string[] {
  const paths: string[] = [];
  for (const obj of symbolImports) {
    if (!isObjWithExporterPath(obj)) {
      continue;
    }
    if (
      isPathWithinDirectory(obj.exporter.path, absoluteProjectPath) &&
      !paths.includes(obj.exporter.path)
    ) {
      paths.push(obj.exporter.path);
    }
  }
  return paths;
}

/**
 * Resolve project path and repo root for symbol-usage.
 *
 * Relative paths resolve against `repoRoot` (or cwd's git root). Absolute
 * paths resolve against their own git root.
 */
export function resolveProjectPath(
  projectPath: string,
  cwd: string,
  repoRoot?: string,
): { absoluteProjectPath: string; repoRoot: string } {
  if (isAbsolute(projectPath)) {
    const absoluteProjectPath = resolve(projectPath);
    const projectRepoRoot = findGitRepoRoot(absoluteProjectPath);
    return { absoluteProjectPath, repoRoot: projectRepoRoot };
  }

  const resolvedRepoRoot =
    repoRoot !== undefined ? repoRoot : findGitRepoRoot(cwd);
  const absoluteProjectPath = resolve(resolvedRepoRoot, projectPath);
  return { absoluteProjectPath, repoRoot: resolvedRepoRoot };
}

interface SymbolUsageOptions {
  /**
   * Repository root to resolve relative project path against.
   * When omitted, resolves against the git repo root of cwd.
   */
  repoRoot?: string;
  fresh: boolean;
  cwd: string;
}

export async function runSymbolUsage(
  projectPath: string,
  symbolName: string,
  debugOptions: DebugOptions,
  options: SymbolUsageOptions,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  const { absoluteProjectPath, repoRoot: targetRepoRoot } = resolveProjectPath(
    projectPath,
    options.cwd,
    options.repoRoot,
  );
  const db = openStorage(debugOptions, {
    verbose: true,
    fresh: options.fresh,
    basePath: targetRepoRoot,
    inMemory: false,
  });
  await updateStorage(targetRepoRoot, db, true, fileSystem, writer);

  console.log(
    '⚠️  WARNING: This command uses loose symbol name matching and may return',
  );
  console.log(
    '   unrelated symbols with the same name from different modules.',
  );
  console.log(
    '   Use this for exploration only, NOT for refactoring decisions.',
  );
  console.log(
    '   For refactoring, use fully qualified symbol analysis instead.',
  );
  console.log();

  const symbolImports = db.getSymbolImports(symbolName);
  const allExporterPaths = collectExporterPaths(
    symbolImports,
    absoluteProjectPath,
  );

  if (allExporterPaths.length === 0) {
    console.log(
      `Symbol '${symbolName}' not found in project ${absoluteProjectPath}`,
    );
    return;
  }

  console.log(`Symbol '${symbolName}' exported by:`);
  allExporterPaths.sort();
  for (const exporterPath of allExporterPaths) {
    console.log(`  ${exporterPath}`);
  }
  console.log();

  for (const exporterPath of allExporterPaths) {
    const importers = db.getImportersOfExport(exporterPath, symbolName);
    if (importers.length > 0) {
      console.log(`${exporterPath}:${symbolName} used by:`);
      importers.sort();
      for (const importerPath of importers) {
        console.log(`  ${importerPath}`);
      }
      console.log();
    }
  }

  db.save();
}
