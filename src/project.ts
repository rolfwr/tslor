import { existsSync } from 'fs';
import { dirname } from 'path';
import { FileSystem } from './filesystem';
import { CliError } from './errors';

export function findGitRepoRoot(oldPath: string) {
  let repoRoot = oldPath;
  while (!existsSync(repoRoot + '/.git')) {
    const parent = dirname(repoRoot);
    if (parent === repoRoot) {
      throw new CliError('Git repo root not found');
    }
    repoRoot = parent;
  }
  return repoRoot;
}

export async function getTypeScriptFilePaths(
  repoRoot: string,
  fileSystem: FileSystem,
): Promise<string[]> {
  const paths: string[] = [];
  await forEachTsFile(repoRoot, fileSystem, async (file) => {
    paths.push(file);
  });

  return paths;
}

async function forEachTsFile(
  dir: string,
  fileSystem: FileSystem,
  cb: (file: string) => Promise<void>,
): Promise<void> {
  if (dir.endsWith('/')) {
    dir = dir.slice(0, -1);
  }
  const entries = await fileSystem.readdir(dir);
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || name.startsWith('_')) {
      continue;
    }
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue;
      }
      await forEachTsFile(path, fileSystem, cb);
    } else if (
      entry.isFile() &&
      (path.endsWith('.ts') || path.endsWith('.vue'))
    ) {
      await cb(path);
    }
  }
}

/**
 * TODO: Add cache
 */
export async function getTsconfigPathForFile(
  root: string,
  file: string,
  fileSystem: FileSystem,
): Promise<string | null> {
  let dir = dirname(file);
  while (true) {
    const tsconfigPath = `${dir}/tsconfig.json`;
    try {
      const exists = await fileSystem.exists(tsconfigPath);
      if (exists) {
        return tsconfigPath;
      }
    } catch {
      // For in-memory filesystems, exists() might throw instead of returning false
      // In that case, continue searching
    }
    if (dir === root) {
      return null;
    }
    dir = dirname(dir);
  }
}
