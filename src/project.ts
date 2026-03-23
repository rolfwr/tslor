import { existsSync } from "fs";
import { dirname } from "path";
import { FileSystem, RealFileSystem } from "./filesystem";


export function findGitRepoRoot(oldPath: string) {
  let repoRoot = oldPath;
  while (!existsSync(repoRoot + '/.git')) {
    const parent = dirname(repoRoot);
    if (parent === repoRoot) {
      throw new Error('Git repo root not found');
    }
    repoRoot = parent;
  }
  return repoRoot;
}

export async function getTypeScriptFilePaths(repoRoot: string, verbose: boolean) {
  const paths: string[] = [];
  await forEachTsFile(repoRoot, async (file) => {
    paths.push(file);
  });

  if (verbose) {
    console.log('Found ' + paths.length + ' TypeScript files.');
  }
  return paths;
}

async function forEachTsFile(dir: string, cb: (file: string) => Promise<void>) {
    if (dir.endsWith('/')) {
      dir = dir.slice(0, -1);
    }
    const { readdir } = await import('fs/promises');
    const entries = await readdir(dir, { withFileTypes: true });
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
        await forEachTsFile(path, cb);
      } else if (entry.isFile() && (path.endsWith('.ts') || path.endsWith('.vue'))) {
        await cb(path);
      }
    }
  }
  
/**
 * TODO: Add cache
 */
export async function getTsconfigPathForFile(root: string, file: string, fileSystem: FileSystem): Promise<string | null> {
  let dir = dirname(file);
  while (true) {
    const tsconfigPath = `${dir}/tsconfig.json`;
    try {
      const exists = await fileSystem.exists(tsconfigPath);
      if (exists) {
        return tsconfigPath;
      }
    } catch (err) {
      // For in-memory filesystems, exists() might throw instead of returning false
      // In that case, continue searching
    }
    if (dir === root) {
      return null;
    }
    dir = dirname(dir);
  }
}

