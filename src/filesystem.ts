/**
 * Filesystem abstraction for TSLOR operations.
 *
 * We create our own filesystem interface rather than using ts-morph's FileSystemHost because:
 * 1. FileSystemHost is designed primarily for ts-morph's internal AST operations
 * 2. We need additional operations like stat() for file timestamps that FileSystemHost doesn't provide
 * 3. We want a clean separation between ts-morph's file access (for AST operations) and our indexing operations
 * 4. This allows us to easily mock filesystem operations for testing without affecting ts-morph's behavior
 *
 * For in-memory testing, we provide an implementation that works with ts-morph's InMemoryFileSystemHost
 * where possible, but we maintain our own interface for the operations we specifically need.
 */


export interface FileSystem {
  /**
   * Get file stats (size, modification time, etc.)
   */
  stat(filePath: string): Promise<{ mtimeMs: number; isFile(): boolean }>;

  /**
   * Check if a file exists
   */
  exists(filePath: string): Promise<boolean>;

  /**
   * Read a file's contents
   */
  readFile(filePath: string, encoding?: string): Promise<string>;
}

/**
 * Real filesystem implementation using Node.js fs/promises
 */
export class RealFileSystem implements FileSystem {
  async stat(filePath: string): Promise<{ mtimeMs: number; isFile(): boolean }> {
    const { stat } = await import('fs/promises');
    const stats = await stat(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      isFile: () => stats.isFile()
    };
  }

  async exists(filePath: string): Promise<boolean> {
    const { access } = await import('fs/promises');
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(filePath: string, encoding?: string): Promise<string> {
    const { readFile } = await import('fs/promises');
    return readFile(filePath, { encoding: encoding as BufferEncoding || 'utf-8' });
  }
}

/**
 * In-memory filesystem implementation for testing
 */
export class InMemoryFileSystem implements FileSystem {
  private files = new Map<string, { content: string; mtimeMs: number }>();

  constructor(initialFiles: Map<string, string> = new Map()) {
    for (const [path, content] of initialFiles) {
      this.files.set(path, { content, mtimeMs: Date.now() });
    }
  }

  async stat(filePath: string): Promise<{ mtimeMs: number; isFile(): boolean }> {
    const file = this.files.get(filePath);
    if (file) {
      return {
        mtimeMs: file.mtimeMs,
        isFile: () => true
      };
    }
    
    // Check if this is a directory by seeing if any files are under it
    const dirPrefix = filePath.endsWith('/') ? filePath : filePath + '/';
    const hasChildren = Array.from(this.files.keys()).some(path => path.startsWith(dirPrefix));
    
    if (hasChildren) {
      return {
        mtimeMs: Date.now(),
        isFile: () => false
      };
    }
    
    throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
  }

  async exists(filePath: string): Promise<boolean> {
    if (this.files.has(filePath)) {
      return true;
    }
    
    // Check if this is a directory by seeing if any files are under it
    const dirPrefix = filePath.endsWith('/') ? filePath : filePath + '/';
    return Array.from(this.files.keys()).some(path => path.startsWith(dirPrefix));
  }

  async readFile(filePath: string, _encoding?: string): Promise<string> {
    const file = this.files.get(filePath);
    if (!file) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }
    return file.content;
  }

  /**
   * Add or update a file in the in-memory filesystem
   */
  setFile(path: string, content: string): void {
    this.files.set(path, { content, mtimeMs: Date.now() });
  }

  /**
   * Remove a file from the in-memory filesystem
   */
  deleteFile(path: string): void {
    this.files.delete(path);
  }

  /**
   * Get all file paths
   */
  getFilePaths(): string[] {
    return Array.from(this.files.keys());
  }
}