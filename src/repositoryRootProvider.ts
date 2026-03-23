/**
 * Repository Root Provider Interface
 *
 * Abstracts repository root detection to support both real filesystem
 * operations and in-memory testing scenarios.
 */

export interface RepositoryRootProvider {
  /**
   * Find the repository root for a given path
   */
  findRepositoryRoot(path: string): string;

  /**
   * Get all TypeScript file paths within the repository
   */
  getTypeScriptFilePaths(repoRoot: string, verbose: boolean): Promise<string[]>;
}

/**
 * Real filesystem implementation that uses git repository detection
 */
export class GitRepositoryRootProvider implements RepositoryRootProvider {
  findRepositoryRoot(path: string): string {
    const { findGitRepoRoot } = require('./project');
    return findGitRepoRoot(path);
  }

  async getTypeScriptFilePaths(repoRoot: string, verbose: boolean): Promise<string[]> {
    const { getTypeScriptFilePaths } = await import('./project');
    return getTypeScriptFilePaths(repoRoot, verbose);
  }
}

/**
 * In-memory implementation for testing that doesn't require git repositories
 */
export class InMemoryRepositoryRootProvider implements RepositoryRootProvider {
  private repoRoot: string;
  private tsFiles: string[];

  constructor(repoRoot: string, tsFiles: string[] = []) {
    this.repoRoot = repoRoot;
    this.tsFiles = tsFiles;
  }

  findRepositoryRoot(path: string): string {
    // For in-memory testing, always return the configured repo root
    return this.repoRoot;
  }

  async getTypeScriptFilePaths(repoRoot: string, verbose: boolean): Promise<string[]> {
    if (verbose) {
      console.log(`Found ${this.tsFiles.length} TypeScript files (in-memory).`);
    }
    return this.tsFiles;
  }

  /**
   * Add TypeScript files to the in-memory provider
   */
  addTypeScriptFiles(files: string[]): void {
    this.tsFiles.push(...files);
  }

  /**
   * Clear all TypeScript files
   */
  clearTypeScriptFiles(): void {
    this.tsFiles = [];
  }
}