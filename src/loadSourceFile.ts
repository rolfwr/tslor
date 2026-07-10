import { FileSystem, InMemoryFileSystem, isEnoentError } from "./filesystem";
import { Project, QuoteKind, SourceFile } from "ts-morph";
import { CliError } from "./errors";
import { TransformingFileSystem } from "./transformingFileSystem";

/**
 * Verify that `srcPath` exists on `fileSystem` and is a regular file.
 * Throws {@link CliError} for missing paths or non-file entries.
 */
async function assertIsFile(
  srcPath: string,
  fileSystem: FileSystem,
): Promise<void> {
  try {
    const stat = await fileSystem.stat(srcPath);
    if (!stat.isFile()) {
      throw new CliError('Not a file: ' + srcPath, {});
    }
  } catch (err) {
    if (isEnoentError(err)) {
      throw new CliError('Not found: ' + srcPath, {});
    }
    throw err;
  }
}

/**
 * Load a source file into a disk-backed ts-morph project.
 *
 * Uses {@link TransformingFileSystem} so `.vue` single-file components
 * are automatically extracted to their `<script>` block. The returned
 * SourceFile is attached to a real-project instance that can resolve
 * imports against disk — suitable for callers that need binder APIs
 * or save back via sourceFile.save().
 *
 * Delegates to {@link loadSourceFileForAnalysis} when `fileSystem` is
 * an {@link InMemoryFileSystem} (test path), which seals the project
 * and prevents cross-module resolution.
 *
 * @throws {@link CliError} if the path does not exist or is not a file.
 */
export async function loadSourceFile(
  srcPath: string,
  fileSystem: FileSystem,
): Promise<SourceFile> {
  /*
    In-memory projects (used in tests) must read from the provided fileSystem
    directly, as TransformingFileSystem delegates to the real disk. Delegate
    early to loadSourceFileForAnalysis which handles the file validation.
  */
  if (fileSystem instanceof InMemoryFileSystem) {
    return loadSourceFileForAnalysis(srcPath, fileSystem);
  }

  await assertIsFile(srcPath, fileSystem);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Single,
    },
    fileSystem: new TransformingFileSystem(),
  });

  return project.addSourceFileAtPath(srcPath);
}

/**
 * Load a source file inside a sealed in-memory project.
 *
 * The sealed project (useInMemoryFileSystem) guarantees that
 * binder APIs like getLocals() do not pull in ts.Program resolution
 * against the real filesystem. Use this for analysis-only callers
 * such as parseModule; do not use when the source file must later
 * be saved back to disk via sourceFile.save().
 */
export async function loadSourceFileForAnalysis(
  srcPath: string,
  fileSystem: FileSystem,
): Promise<SourceFile> {
  await assertIsFile(srcPath, fileSystem);

  const content = await fileSystem.readFile(srcPath);
  /*
    skipLoadingLibFiles keeps the binder from parsing the bundled lib.d.ts
    set into this per-module program. This runs once per file during indexing;
    parseModule's getLocals() reads only module-scope locals, so lib globals
    never contribute to the result, but loading them costs ~51ms/file vs
    0.35ms/file — the difference between a usable and an unusable index.
  */
  const project = new Project({
    useInMemoryFileSystem: true,
    skipLoadingLibFiles: true,
  });
  return project.createSourceFile(srcPath, content);
}
