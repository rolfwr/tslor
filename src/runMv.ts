import { spawn } from 'child_process';
import { existsSync, promises as fsp } from 'fs';
import { basename, dirname, relative, resolve } from 'path';
import { ImportDeclaration, Node, SourceFile, SyntaxKind } from 'ts-morph';
import { CliError } from './errors';
import { FileSystem } from './filesystem';
import { modulePathSpec } from './importSpec';
import {
  indexImportFromFiles,
  loadSourceFile,
  NamedExport,
  resolveImportSpec,
  resolveImportSpecAlias,
} from './indexing';
import { invariant } from './invariant';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath } from './pathUtils';
import {
  findGitRepoRoot,
  getTsconfigPathForFile,
  getTypeScriptFilePaths,
} from './project';
import { openStorage, Storage } from './storage';

interface FileMove {
  oldPath: string;
  newPath: string;
}

export async function runMv(
  oldPathArg: string,
  newPathArg: string,
  debugOptions: DebugOptions,
  fresh: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  if (!oldPathArg || !newPathArg) {
    throw new CliError('Missing path arguments');
  }

  const oldPath = normalizeAndValidatePath(oldPathArg, 'Source file', false);
  const repoRoot = findGitRepoRoot(oldPath);

  /*
    Resolve newPathArg relative to the repo root, not the current working
    directory. This ensures that `tslor mv src/a.ts dest` from a subdirectory
    places the file at <repo>/dest/a.ts rather than <cwd>/dest/a.ts.
  */
  let newPath = resolve(repoRoot, newPathArg);

  // If new path is a directory, append the base name of the old path
  const stat = await fsp.stat(newPath).catch(() => null);
  if (stat && stat.isDirectory()) {
    newPath = resolve(newPath, basename(oldPath));
  }

  if (oldPath === newPath) {
    throw new CliError(`Source and destination are the same file: ${oldPath}`);
  }

  if (!existsSync(newPath)) {
    if (!existsSync(oldPath)) {
      throw new CliError('Neither old nor new path exists');
    }

    // Run "git mv" command
    const cmd = 'git';
    const args = ['mv', oldPath, newPath];
    writer('+ ' + cmd + ' ' + args.join(' ') + '\n');
    const git = spawn(cmd, args, { cwd: repoRoot, stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      git.on('close', (code: number) => {
        if (code === 0) {
          resolve(null);
        } else {
          reject(new Error('Git mv failed'));
        }
      });
    });
  }

  const fixupFileMove: FileMove = {
    oldPath,
    newPath,
  };

  const db = openStorage(debugOptions, {
    verbose: true,
    fresh,
    basePath: repoRoot,
    inMemory: false,
  });
  await mvCore(db, repoRoot, fixupFileMove, fileSystem, writer);
  db.save();
}

/**
 * Describes a single export that needs to be rewritten after a file move.
 *
 * `oldExport` points to the location importers currently reference;
 * `newExport` points to the location after the move.
 */
interface MoveFixup {
  oldExport: NamedExport;
  newExport: NamedExport;
}

function toRelativeModuleSpec(fromPath: string, toPath: string): string {
  const relPath = relative(dirname(fromPath), toPath);
  const spec = relPath.startsWith('.') ? relPath : './' + relPath;
  return modulePathSpec(spec);
}

async function resolveNewSpecifier(
  repoRoot: string,
  fromPath: string,
  resolvedPath: string,
  fileSystem: FileSystem,
): Promise<string> {
  try {
    const alias = await resolveImportSpecAlias(
      repoRoot,
      fromPath,
      resolvedPath,
      fileSystem,
    );
    if (alias) {
      return alias;
    }
  } catch {
    // Alias resolution failed (no tsconfig or I/O error); fall back to relative path
  }
  return toRelativeModuleSpec(fromPath, resolvedPath);
}

async function fixImportsInMovedFile(
  repoRoot: string,
  fixupFileMove: FileMove,
  fileSystem: FileSystem,
  writer: (message: string) => void,
): Promise<void> {
  const oldTsconfigPath = await getTsconfigPathForFile(
    repoRoot,
    fixupFileMove.oldPath,
    fileSystem,
  );
  const newTsconfigPath = await getTsconfigPathForFile(
    repoRoot,
    fixupFileMove.newPath,
    fileSystem,
  );
  const sameTsconfig =
    oldTsconfigPath !== null &&
    newTsconfigPath !== null &&
    oldTsconfigPath === newTsconfigPath;

  const movedModule = await loadSourceFile(fixupFileMove.newPath, fileSystem);
  for (const imp of movedModule.getImportDeclarations()) {
    const moduleSpecifier = imp.getModuleSpecifierValue();

    /*
      Resolve the original specifier from the old location. Alias imports
      require a tsconfig; relative imports resolve without one.
    */
    let resolvedPath: string | null = null;
    try {
      resolvedPath = await resolveImportSpec(
        repoRoot,
        fixupFileMove.oldPath,
        moduleSpecifier,
        fileSystem,
      );
    } catch {
      // Old file has no tsconfig; alias imports can't be resolved
      continue;
    }
    if (!resolvedPath) {
      continue;
    }

    /*
      Alias imports within the same tsconfig don't need rewriting.
    */
    if (!moduleSpecifier.startsWith('.') && sameTsconfig) {
      continue;
    }

    const newSpecifier = moduleSpecifier.startsWith('.')
      ? toRelativeModuleSpec(fixupFileMove.newPath, resolvedPath)
      : await resolveNewSpecifier(
          repoRoot,
          fixupFileMove.newPath,
          resolvedPath,
          fileSystem,
        );

    if (newSpecifier !== moduleSpecifier) {
      imp.setModuleSpecifier(newSpecifier);
    }
  }
  if (!movedModule.isSaved()) {
    await movedModule.save();
    writer('M ' + movedModule.getFilePath() + '\n');
  }
}

async function mvCore(
  db: Storage,
  repoRoot: string,
  fixupFileMove: FileMove,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  const srcPath = fixupFileMove.newPath;
  if (!existsSync(srcPath)) {
    writer('Fixup File Move New Path does not exist: ' + srcPath + '\n');
    return;
  }

  await fixImportsInMovedFile(repoRoot, fixupFileMove, fileSystem, writer);

  const moveFixups: MoveFixup[] = await getFixups(
    srcPath,
    fixupFileMove.oldPath,
    fileSystem,
  );
  if (moveFixups.length === 0) {
    writer('No fixups needed\n');
    return;
  }

  const paths: string[] = await getTypeScriptFilePaths(repoRoot, fileSystem);
  for (const fixup of moveFixups) {
    await applyFixup(db, repoRoot, paths, fixup, fileSystem, writer);
  }
}

/**
 * Scan the moved file and return fixup records for every named export
 * it declares, mapping each export from `oldPath` to `srcPath`.
 *
 * @param srcPath - Absolute path to the file at its new location
 * @param oldPath - Absolute path to the file at its previous location
 * @param fileSystem - Filesystem abstraction for loading the source
 * @returns Array of fixup records, one per exported symbol
 */
export async function getFixups(
  srcPath: string,
  oldPath: string,
  fileSystem: FileSystem,
): Promise<MoveFixup[]> {
  const sourceFile = await loadSourceFile(srcPath, fileSystem);
  const exports: NamedExport[] = [];

  sourceFile.forEachChild((node) => {
    switch (node.getKind()) {
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.EnumDeclaration:
        collectDeclarationExports(node, srcPath, exports);
        break;
      case SyntaxKind.VariableStatement:
        collectVariableExports(node, srcPath, exports);
        break;
    }
  });

  return exports.map((exp) => ({
    oldExport: {
      type: 'NamedExport' as const,
      path: oldPath,
      name: exp.name,
    },
    newExport: exp,
  }));
}

function collectDeclarationExports(
  node: Node,
  srcPath: string,
  exports: NamedExport[],
): void {
  let hasExportKeyword = false;
  let identifier: Node | undefined;
  let isDefault = false;

  node.forEachChild((child) => {
    switch (child.getKind()) {
      case SyntaxKind.ExportKeyword:
        hasExportKeyword = true;
        break;
      case SyntaxKind.Identifier:
        identifier = child;
        break;
      case SyntaxKind.DefaultKeyword:
        isDefault = true;
        break;
    }
  });

  if (!hasExportKeyword) {
    return;
  }

  /*
    For `export default function foo()`, `foo` is a local binding, not a
    named export. Only push the identifier for non-default exports.
  */
  if (isDefault) {
    exports.push({ type: 'NamedExport', path: srcPath, name: 'default' });
  } else {
    invariant(
      identifier,
      `Exported declaration in ${srcPath} has no identifier`,
    );
    exports.push({
      type: 'NamedExport',
      path: srcPath,
      name: identifier.getText(),
    });
  }
}

function collectVariableExports(
  node: Node,
  srcPath: string,
  exports: NamedExport[],
): void {
  const varStatement = node.asKind(SyntaxKind.VariableStatement);
  if (!varStatement || !varStatement.hasModifier(SyntaxKind.ExportKeyword)) {
    return;
  }
  for (const decl of varStatement.getDeclarations()) {
    const name = decl.getName();
    exports.push({ type: 'NamedExport', path: srcPath, name });
  }
}

async function applyFixup(
  db: Storage,
  repoRoot: string,
  paths: string[],
  fixup: MoveFixup,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  /*
    TODO: Instead of rescanning all files, we can keep track of which files have
    modified between each fixup.
  */

  await indexImportFromFiles(paths, db, repoRoot, true, fileSystem, writer);

  const importers = db.getImportersOfExport(
    fixup.oldExport.path,
    fixup.oldExport.name,
  );

  for (const importer of importers) {
    await updateImportDeclarations(
      importer,
      repoRoot,
      fixup,
      fileSystem,
      writer,
    );
  }
}

interface UnresolvedImportDecls {
  node: ImportDeclaration;
  moduleSpec: string;
}

function collectUnresolvedImports(
  sourceFile: SourceFile,
): UnresolvedImportDecls[] {
  const unresolvedImports: UnresolvedImportDecls[] = [];
  sourceFile.forEachChild((node) => {
    const importDecl = node.asKind(SyntaxKind.ImportDeclaration);
    if (!importDecl) {
      return;
    }
    const moduleSpecifier = importDecl.getModuleSpecifier();
    invariant(moduleSpecifier !== undefined, 'No module specifier found');
    unresolvedImports.push({
      node: importDecl,
      moduleSpec: moduleSpecifier.getLiteralText(),
    });
  });
  return unresolvedImports;
}

function moveDefaultExport(
  unres: UnresolvedImportDecls,
  targetDecl: ImportDeclaration,
  fixup: MoveFixup,
): void {
  const oldDefaultImport = unres.node.getDefaultImport();
  invariant(
    oldDefaultImport,
    'No default import found for fixup ' + JSON.stringify(fixup),
  );
  const localDefaultName = oldDefaultImport.getText();
  unres.node.removeDefaultImport();
  targetDecl.setDefaultImport(localDefaultName);
}

function moveNamedExport(
  unres: UnresolvedImportDecls,
  targetDecl: ImportDeclaration,
  fixup: MoveFixup,
): boolean {
  const oldNamedImports = unres.node.getNamedImports();
  const oldNamespaceImport = unres.node.getNamespaceImport();

  if (oldNamespaceImport) {
    throw new CliError('Namespace imports not supported');
  }
  if (oldNamedImports.length === 0) {
    return false;
  }

  const oldNamedImport = oldNamedImports.find(
    (ni) => ni.getName() === fixup.oldExport.name,
  );
  if (!oldNamedImport) {
    return false;
  }

  const localName = oldNamedImport.getName();
  oldNamedImport.remove();
  if (localName !== fixup.newExport.name) {
    throw new CliError('Aliases not supported');
  }
  targetDecl.addNamedImport(fixup.newExport.name);
  return true;
}

async function updateImportDeclarations(
  importer: string,
  repoRoot: string,
  fixup: MoveFixup,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  const importerSourceFile = await loadSourceFile(importer, fileSystem);
  const unresolvedImports = collectUnresolvedImports(importerSourceFile);

  const moduleSpecifier = await resolveNewSpecifier(
    repoRoot,
    importer,
    fixup.newExport.path,
    fileSystem,
  );

  for (const unres of unresolvedImports) {
    let resolvedPath: string | null = null;
    try {
      resolvedPath = await resolveImportSpec(
        repoRoot,
        importer,
        unres.moduleSpec,
        fileSystem,
      );
    } catch {
      // Importer has no tsconfig; alias imports can't be resolved
      continue;
    }
    if (!resolvedPath || resolvedPath !== fixup.oldExport.path) {
      continue;
    }

    const indexAfter = unres.node.getChildIndex() + 1;
    const targetDecl = importerSourceFile.insertImportDeclaration(indexAfter, {
      moduleSpecifier,
    });

    if (fixup.oldExport.name === 'default') {
      moveDefaultExport(unres, targetDecl, fixup);
    } else if (!moveNamedExport(unres, targetDecl, fixup)) {
      targetDecl.remove();
      continue;
    }

    if (isEmptyImportDecl(unres.node)) {
      unres.node.remove();
    }
  }

  if (!importerSourceFile.isSaved()) {
    await importerSourceFile.save();
    writer('M ' + importerSourceFile.getFilePath() + '\n');
  }
}

function isEmptyImportDecl(imp: ImportDeclaration): boolean {
  return (
    !imp.getDefaultImport() &&
    imp.getNamedImports().length === 0 &&
    !imp.getNamespaceImport()
  );
}
