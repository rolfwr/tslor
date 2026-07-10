/**
 * Path utilities for consistent path handling across TSLOR.
 *
 * This module implements the "early normalization" pattern:
 * - All file paths are resolved to absolute paths as early as possible
 * - Internal operations work with absolute paths
 * - Display/output functions can optionally denormalize paths for user-friendly output
 */

import { resolve, relative, sep } from 'path';
import { existsSync } from 'fs';
import { CliError } from './errors';

/**
 * Normalize a file path to an absolute path.
 * This should be used as early as possible in command handlers.
 */
export function normalizePath(filePath: string): string {
  return resolve(filePath);
}

/**
 * Validate that a normalized path exists and throw a descriptive error if not.
 */
export function validatePathExists(
  normalizedPath: string,
  description: string,
): void {
  if (!existsSync(normalizedPath)) {
    throw new CliError(`${description} does not exist: ${normalizedPath}`, {});
  }
}

/**
 * Convert an absolute path to a relative path for user-friendly display.
 *
 * @param absolutePath The absolute path to denormalize
 * @param basePath The base path to make relative from
 */
export function denormalizePath(
  absolutePath: string,
  basePath: string,
): string {
  const base = resolve(basePath);
  const relativePath = relative(base, absolutePath);

  /*
    If the relative path is shorter and doesn't go up too many levels, use it.
    Otherwise, keep the absolute path for clarity.
  */
  if (
    relativePath.length < absolutePath.length &&
    !relativePath.startsWith('../../..')
  ) {
    return relativePath;
  }

  return absolutePath;
}

/**
 * Utility for command handlers: normalize input paths and validate existence.
 * This encapsulates the common pattern of path handling at command entry points.
 */
export function normalizeAndValidatePath(
  inputPath: string,
  description: string,
  skipValidation: boolean,
): string {
  const normalized = normalizePath(inputPath);
  if (!skipValidation) {
    validatePathExists(normalized, description);
  }
  return normalized;
}

/**
 * Check whether `filePath` resides inside `directoryPath`.
 *
 * Appends the platform separator to the directory before calling `startsWith`
 * so that "/src/other.ts" does not falsely match directory "/src/o".
 * Also handles the edge case where the file path equals the directory path exactly.
 *
 * @param filePath The file or directory path to check
 * @param directoryPath The parent directory to test against
 * @returns True if `filePath` is inside or equal to `directoryPath`
 */
export function isPathWithinDirectory(
  filePath: string,
  directoryPath: string,
): boolean {
  const absoluteFile = normalizePath(filePath);
  const absoluteDirectory = normalizePath(directoryPath);

  return (
    absoluteFile === absoluteDirectory ||
    absoluteFile.startsWith(absoluteDirectory + sep)
  );
}
