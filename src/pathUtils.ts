/**
 * Path utilities for consistent path handling across TSLOR.
 * 
 * This module implements the "early normalization" pattern:
 * - All file paths are resolved to absolute paths as early as possible
 * - Internal operations work with absolute paths
 * - Display/output functions can optionally denormalize paths for user-friendly output
 */

import { resolve, relative } from "path";
import { existsSync } from "fs";

/**
 * Normalize a file path to an absolute path.
 * This should be used as early as possible in command handlers.
 */
export function normalizePath(filePath: string): string {
  return resolve(filePath);
}

/**
 * Normalize multiple file paths to absolute paths.
 */
export function normalizePaths(filePaths: string[]): string[] {
  return filePaths.map(path => resolve(path));
}

/**
 * Validate that a normalized path exists and throw a descriptive error if not.
 */
export function validatePathExists(normalizedPath: string, description: string = "Path"): void {
  if (!existsSync(normalizedPath)) {
    throw new Error(`${description} does not exist: ${normalizedPath}`);
  }
}

/**
 * Convert an absolute path to a relative path for user-friendly display.
 * This can be used in console output to show shorter, more readable paths.
 * 
 * @param absolutePath The absolute path to denormalize
 * @param basePath The base path to make relative from
 */
export function denormalizePath(absolutePath: string, basePath: string): string {
  const base = resolve(basePath);
  const relativePath = relative(base, absolutePath);
  
  // If the relative path is shorter and doesn't go up too many levels, use it
  // Otherwise, keep the absolute path for clarity
  if (relativePath.length < absolutePath.length && !relativePath.startsWith("../../..")) {
    return relativePath;
  }
  
  return absolutePath;
}

/**
 * Utility for command handlers: normalize input paths and validate existence.
 * This encapsulates the common pattern of path handling at command entry points.
 */
export function normalizeAndValidatePath(inputPath: string, description: string, skipValidation: boolean): string {
  const normalized = normalizePath(inputPath);
  if (!skipValidation) {
    validatePathExists(normalized, description);
  }
  return normalized;
}

/**
 * Utility for command handlers: normalize multiple input paths and validate existence.
 */
export function normalizeAndValidatePaths(inputPaths: string[], description: string): string[] {
  return inputPaths.map(path => normalizeAndValidatePath(path, description, false));
}