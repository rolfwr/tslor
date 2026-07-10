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
 *
 * `.vue` single-file components are automatically extracted to their `<script>` block
 * content on read, matching the behavior of TransformingFileSystem for ts-morph callers.
 */

/**
 * Directory entry returned by {@link FileSystem.readdir}.
 */
export interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * A file's full on-disk content — for a `.vue` SFC, the raw text including
 * `<template>`/`<style>`, not the extracted `<script>` block. Branded so a
 * plain `string` (in particular, the extracted content {@link FileSystem.readFile}
 * returns) cannot be passed as {@link readTransformableFile}'s or
 * {@link reconstructFileContent}'s raw-content argument without an explicit,
 * deliberate cast — passing extracted content where the raw SFC is required
 * silently corrupts `.vue` files on write. Scoped to that one boundary (not
 * to {@link reinsertScript}/{@link extractScript} themselves, which stay
 * plain `string`) so the brand does not force casts onto callers that read
 * genuinely raw bytes through a path other than {@link FileSystem} — e.g.
 * `transformingFileSystem.ts`'s direct `fs.readFile` calls, which never had
 * this defect and gain nothing from re-proving it here.
 */
export type RawFileContent = string & { readonly __brand: 'RawFileContent' };

export interface FileSystem {
  /**
   * Get file stats (size, modification time, etc.)
   *
   * @throws {@link FileSystemError} with code 'ENOENT' if the path does not exist;
   *         other system errors may also be thrown.
   */
  stat(filePath: string): Promise<{ mtimeMs: number; isFile(): boolean }>;

  /**
   * Check if a file exists
   */
  exists(filePath: string): Promise<boolean>;

  /**
   * Read a file's contents.
   *
   * For `.vue` single-file components the returned string is the extracted
   * `<script>` block rather than the raw SFC text.
   *
   * @throws {@link FileSystemError} with code 'ENOENT' if the file does not exist;
   *         with code 'EBADCONTENT' if the `.vue` `<script>` block is malformed;
   *         other system errors may also be thrown.
   */
  readFile(filePath: string, encoding?: string): Promise<string>;

  /**
   * Read a file's raw contents without any transformation.
   *
   * Unlike {@link readFile}, `.vue` single-file components are returned
   * as-is (full SFC text) rather than with the `<script>` block extracted.
   *
   * @throws {@link FileSystemError} with code 'ENOENT' if the file does not exist;
   *         other system errors may also be thrown.
   */
  readFileRaw(filePath: string): Promise<RawFileContent>;

  /**
   * Read directory entries.
   *
   * @throws {@link FileSystemError} with code 'ENOENT' if the directory does not exist;
   *         other system errors may also be thrown.
   */
  readdir(dirPath: string): Promise<Dirent[]>;
}

/**
 * Error thrown by {@link FileSystem} implementations for system-level
 * failures. Mirrors the shape of Node.js `ErrnoException` so callers can
 * check {@code err.code} without type assertions.
 */
export class FileSystemError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Type guard that checks whether an error carries an 'ENOENT' system error
 * code. Works with both {@link FileSystemError} and Node.js
 * `ErrnoException` without type assertions.
 */
export function isEnoentError(err: unknown): err is { code: 'ENOENT' } {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/**
 * Extract the `<script>` block from `.vue` SFC content, wrapping any
 * parse error in a {@link FileSystemError} so callers need not distinguish
 * extraction failures from filesystem failures.
 */
function applyVueExtraction(content: string, filePath: string): string {
  if (!filePath.endsWith('.vue')) {
    return content;
  }
  try {
    return extractScript(content);
  } catch (err) {
    throw new FileSystemError('EBADCONTENT', `read '${filePath}'`, err);
  }
}

/**
 * Real filesystem implementation using Node.js fs/promises
 */
export class RealFileSystem implements FileSystem {
  async stat(
    filePath: string,
  ): Promise<{ mtimeMs: number; isFile(): boolean }> {
    const { stat } = await import('fs/promises');
    try {
      const stats = await stat(filePath);
      return {
        mtimeMs: stats.mtimeMs,
        isFile: () => stats.isFile(),
      };
    } catch (err) {
      if (isEnoentError(err)) {
        throw new FileSystemError('ENOENT', `stat '${filePath}'`, err);
      }
      throw err;
    }
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

  async readFile(filePath: string, _encoding?: BufferEncoding): Promise<string> {
    const content = await this.readFileRaw(filePath);
    return applyVueExtraction(content, filePath);
  }

  async readFileRaw(filePath: string): Promise<RawFileContent> {
    const { readFile } = await import('fs/promises');
    try {
      // RATIONALE: brand-minting point — this is the file's actual on-disk bytes.
      // ast-grep-ignore: no-type-assertion
      return (await readFile(filePath, { encoding: 'utf-8' })) as RawFileContent;
    } catch (err) {
      if (isEnoentError(err)) {
        throw new FileSystemError('ENOENT', `open '${filePath}'`, err);
      }
      throw err;
    }
  }

  async readdir(dirPath: string): Promise<Dirent[]> {
    const { readdir } = await import('fs/promises');
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isFile: () => e.isFile(),
        isDirectory: () => e.isDirectory(),
      }));
    } catch (err) {
      if (isEnoentError(err)) {
        throw new FileSystemError('ENOENT', `readdir '${dirPath}'`, err);
      }
      throw err;
    }
  }
}

/**
 * In-memory filesystem implementation for testing
 */
export class InMemoryFileSystem implements FileSystem {
  /*
    Files are stored by absolute path. Directories are implicit — derived from
    the path segments of stored files. This means readdir() and stat() for
    directories compute their answer from the set of known file paths.
  */
  private files = new Map<string, { content: string; mtimeMs: number }>();

  constructor(initialFiles: Map<string, string>) {
    for (const [path, content] of initialFiles) {
      this.files.set(path, { content, mtimeMs: Date.now() });
    }
  }

  async stat(
    filePath: string,
  ): Promise<{ mtimeMs: number; isFile(): boolean }> {
    const file = this.files.get(filePath);
    if (file) {
      return {
        mtimeMs: file.mtimeMs,
        isFile: () => true,
      };
    }

    // Check if this is a directory by seeing if any files are under it
    const dirPrefix = filePath.endsWith('/') ? filePath : filePath + '/';
    const hasChildren = Array.from(this.files.keys()).some((path) =>
      path.startsWith(dirPrefix),
    );

    if (hasChildren) {
      return {
        mtimeMs: Date.now(),
        isFile: () => false,
      };
    }

    throw new FileSystemError('ENOENT', `stat '${filePath}'`);
  }

  async exists(filePath: string): Promise<boolean> {
    if (this.files.has(filePath)) {
      return true;
    }

    // Check if this is a directory by seeing if any files are under it
    const dirPrefix = filePath.endsWith('/') ? filePath : filePath + '/';
    return Array.from(this.files.keys()).some((path) =>
      path.startsWith(dirPrefix),
    );
  }

  async readFile(filePath: string, _encoding?: string): Promise<string> {
    const content = await this.readFileRaw(filePath);
    return applyVueExtraction(content, filePath);
  }

  async readFileRaw(filePath: string): Promise<RawFileContent> {
    const file = this.files.get(filePath);
    if (!file) {
      throw new FileSystemError('ENOENT', `open '${filePath}'`);
    }
    // RATIONALE: brand-minting point — this is the in-memory file's raw content.
    // ast-grep-ignore: no-type-assertion
    return file.content as RawFileContent;
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

  async readdir(dirPath: string): Promise<Dirent[]> {
    const normalizedDir = dirPath.endsWith('/')
      ? dirPath.slice(0, -1)
      : dirPath;
    const dirPrefix = normalizedDir + '/';
    const children = new Map<string, 'file' | 'directory'>();

    for (const path of this.files.keys()) {
      if (!path.startsWith(dirPrefix)) {
        continue;
      }

      const remainder = path.slice(dirPrefix.length);
      const slashIndex = remainder.indexOf('/');

      if (slashIndex === -1) {
        // Direct child file
        children.set(remainder, 'file');
      } else {
        // Child directory (derived from nested file paths)
        const dirName = remainder.slice(0, slashIndex);
        if (!children.has(dirName)) {
          children.set(dirName, 'directory');
        }
      }
    }

    /*
      In the in-memory model, directories are implicit — they exist only if
      files are stored under them. An empty children map means no files share
      the prefix, so the directory does not exist. Throw ENOENT to match
      RealFileSystem behavior.
    */
    if (children.size === 0) {
      throw new FileSystemError('ENOENT', `readdir '${dirPath}'`);
    }

    return Array.from(children.entries()).map(([name, type]) => ({
      name,
      isFile: () => type === 'file',
      isDirectory: () => type === 'directory',
    }));
  }
}

/**
 * Extract the `<script>` block content from a `.vue` single-file component.
 *
 * @throws {Error} if the `<script>` tag is malformed or the round-trip
 *         verification fails.
 */
export function extractScript(code: string): string {
  const pos = code.indexOf('<script');
  if (pos === -1) {
    return '';
  }
  const start = code.indexOf('>', pos);
  if (start === -1) {
    throw new Error('Script tag not closed');
  }
  const end = code.indexOf('</script>', start);
  if (end === -1) {
    throw new Error('Script tag not closed');
  }

  const scriptPart = code.slice(start + 1, end);
  const verify = reinsertScript(code, scriptPart);
  if (verify !== code) {
    throw new Error('Safe script extraction failed');
  }

  return scriptPart;
}

/**
 * Reinsert a `<script>` block into a `.vue` single-file component,
 * replacing the original script content while preserving template and style sections.
 */
export function reinsertScript(code: string, scriptContent: string): string {
  const pos = code.indexOf('<script');
  if (pos === -1) {
    if (scriptContent.trim() === '') {
      return code;
    }
    throw new Error('Script tag for reinsertion not found');
  }
  const start = code.indexOf('>', pos);
  if (start === -1) {
    throw new Error('Script tag not closed');
  }
  const end = code.indexOf('</script>', start);
  if (end === -1) {
    throw new Error('Script tag not closed');
  }

  return code.slice(0, start + 1) + scriptContent + code.slice(end);
}

/**
 * Read a file for a transformation command that needs both the content to
 * scan/parse (extracted script for `.vue`, full text otherwise) and the raw
 * content the file must be reconstructed from and checksummed against. For a
 * non-`.vue` file these are the same content, read once; for `.vue` the raw
 * SFC is fetched with one additional read.
 */
export async function readTransformableFile(
  fileSystem: FileSystem,
  filePath: string,
): Promise<{ scriptContent: string; rawContent: RawFileContent }> {
  const scriptContent = await fileSystem.readFile(filePath, 'utf-8');
  if (filePath.endsWith('.vue')) {
    return { scriptContent, rawContent: await fileSystem.readFileRaw(filePath) };
  }
  // RATIONALE: for a non-.vue file, readFile() and readFileRaw() return
  // identical content (applyVueExtraction is a no-op for those paths), so
  // this is genuinely raw content without a second read.
  // ast-grep-ignore: no-type-assertion
  const rawContent = scriptContent as RawFileContent;
  return { scriptContent, rawContent };
}

/**
 * Reconstruct a transformed file's full on-disk content: for a `.vue` SFC,
 * reinsert the modified script into the raw structure (template/style
 * intact); for any other file, the modified script content already is the
 * full file.
 */
export function reconstructFileContent(
  filePath: string,
  rawContent: RawFileContent,
  modifiedScriptContent: string,
): string {
  return filePath.endsWith('.vue')
    ? reinsertScript(rawContent, modifiedScriptContent)
    : modifiedScriptContent;
}
