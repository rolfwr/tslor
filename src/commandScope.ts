import { normalizePath } from "./pathUtils";
import { getTypeScriptFilePaths } from "./project";
import { FileSystem } from "./filesystem";

/**
 * Resolve hybrid path input (files and/or directories) to a deduplicated set
 * of absolute TypeScript file paths.
 *
 * - File paths are normalized to absolute paths via `normalizePath()`.
 * - Directory paths are expanded to all `.ts`/`.vue` files via
 *   `getTypeScriptFilePaths()`.
 * - The combined result is deduplicated.
 *
 * Directories that contain no TypeScript files contribute nothing to the
 * result (they are silently skipped, matching the behaviour of
 * `getTypeScriptFilePaths` which returns an empty array).
 */
export async function resolveCommandScope(
  paths: string[],
  fileSystem: FileSystem
): Promise<Set<string>> {
  const resolved = new Set<string>();

  for (const inputPath of paths) {
    const normalized = normalizePath(inputPath);
    const stats = await fileSystem.stat(normalized);

    if (stats.isFile()) {
      resolved.add(normalized);
    } else {
      const filePaths = await getTypeScriptFilePaths(normalized, false);
      for (const filePath of filePaths) {
        resolved.add(filePath);
      }
    }
  }

  return resolved;
}
