import { basename, resolve } from "path";
import { normalizeAndValidatePath, normalizePath } from "./pathUtils.js";
import { findGitRepoRoot, getTsconfigPathForFile, getTypeScriptFilePaths } from "./project.js";
import { existsSync, promises as fsp } from "fs";
import { spawn } from "child_process";
import { openStorage } from "./storage.js";
import { Storage } from "./storage.js";
import { indexImportFromFiles, loadSourceFile, NamedExport, resolveImportSpec, resolveImportSpecAlias } from "./indexing.js";
import { Node, ImportDeclaration, SyntaxKind } from "ts-morph";
import { DebugOptions } from "./objstore.js";
import { FileSystem, RealFileSystem } from "./filesystem.js";

interface FileMove {
  oldPath: string;
  newPath: string;
}

export async function runMv(oldPathArg: string, newPathArg: string, debugOptions: DebugOptions, fileSystem: FileSystem) {
  if (!oldPathArg || !newPathArg) {
    throw new Error('Missing path arguments');
  }

  const oldPath = normalizeAndValidatePath(oldPathArg, "Source file", false);
  let newPath = normalizePath(newPathArg);

  // If new path is a directory, append the base name of the old path
  const stat = await fsp.stat(newPath).catch(() => null);
  if (stat && stat.isDirectory()) {
    newPath = normalizePath(resolve(newPath, basename(oldPath)));
  }

  let repoRoot = findGitRepoRoot(oldPath);

  if (!existsSync(newPath)) {
    if (!existsSync(oldPath)) {
      throw new Error('Neither old nor new path exists');
    }


    // Run "git mv" command
    const cmd = 'git';
    const args = ['mv', oldPath, newPath];
    console.log('+ ' + cmd + ' ' + args.join(' '));
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

  const db = openStorage(debugOptions, true);
  await mvCore(db, repoRoot, fixupFileMove, fileSystem);
  db.save();
}


interface MoveFixup {
  oldExport: NamedExport;
  newExport: NamedExport;
};

async function mvCore(db: Storage, repoRoot: string, fixupFileMove: FileMove, fileSystem: FileSystem) {

  const srcPath = fixupFileMove.newPath;

  if (!existsSync(srcPath)) {
    console.log('Fixup File Move New Path does not exist:', srcPath);
    return;
  }

  /*
    Fix the aliases in the moved file itself. The path aliases in the tsconfig
    file used in its previous location may be different than the path aliases in
    the tsconfig file used in its new location.
  */

  const oldTsconfigPath = await getTsconfigPathForFile(repoRoot, fixupFileMove.oldPath, fileSystem);
  const newTsconfigPath = await getTsconfigPathForFile(repoRoot, fixupFileMove.newPath, fileSystem);
  if (oldTsconfigPath && newTsconfigPath && oldTsconfigPath !== newTsconfigPath) {
    const movedModule = await loadSourceFile(fixupFileMove.newPath, fileSystem);

    const importDecls: ImportDeclaration[] = [];
    movedModule.getImportDeclarations().forEach((imp) => {
      importDecls.push(imp);
    });

    for (const imp of importDecls) {
      const moduleSpecifier = imp.getModuleSpecifierValue();
      const resolvedPath = await resolveImportSpec(repoRoot, fixupFileMove.oldPath, moduleSpecifier, fileSystem);
      if (resolvedPath) {
        const newImportAliasSpec = await resolveImportSpecAlias(repoRoot, fixupFileMove.newPath, resolvedPath, fileSystem);
        if (newImportAliasSpec) {
          imp.setModuleSpecifier(newImportAliasSpec);
        }
      }
    }
    if (!movedModule.isSaved()) {
      await movedModule.save();
      console.log('M ' + movedModule.getFilePath());
    }
  }
  

  

  const fixupReferences = true;
  if (fixupReferences) {
    const moveFixups: MoveFixup[] = await getFixups(srcPath, fixupFileMove.oldPath, fileSystem);

    if (moveFixups.length === 0) {
      console.log('No fixups needed'); 
      return;
    }

    /*
      TODO: Group fixups by files that need to be modified.
    */

    const paths: string[] = await getTypeScriptFilePaths(repoRoot, true);

    for (const fixup of moveFixups) {
      await applyFixup(db, repoRoot, paths, fixup, fileSystem);
    }
  }
}

async function getFixups(srcPath: string, oldPath: string, fileSystem: FileSystem) {
  const sourceFile = await loadSourceFile(srcPath, fileSystem);

  const exports: NamedExport[] = [];

  sourceFile.forEachChild((node) => {
    switch (node.getKind()) {
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ClassDeclaration:
        break;
      default:
        return;
    }
    let hasExportKeyword = false;
    let identifier: Node | undefined;
    let isDefault = false;
    node.forEachChild((child) => {
      const kind = child.getKind();
      if (kind === SyntaxKind.ExportKeyword) {
        hasExportKeyword = true;
      } else if (kind === SyntaxKind.Identifier) {
        identifier = child;
      } else if (kind === SyntaxKind.DefaultKeyword) {
        isDefault = true;
      }
    });
    if (!hasExportKeyword) {
      return;
    }

    if (!identifier) {
      throw new Error('No identifier found for export');
    }

    const name = identifier.getText();

    exports.push({
      type: 'NamedExport',
      path: srcPath,
      name,
    });

    if (isDefault) {
      exports.push({
        type: 'NamedExport',
        path: srcPath,
        name: 'default',
      });
    }
  });

  const moveFixups: MoveFixup[] = [];
  for (const exp of exports) {
    if (exp.path !== srcPath) {
      throw new Error('Export path mismatch');
    }
    moveFixups.push({
      oldExport: {
        type: 'NamedExport',
        path: oldPath,
        name: exp.name,
      },
      newExport: exp,
    });
  }

  return moveFixups;
}

async function applyFixup(db: Storage, repoRoot: string, paths: string[], fixup: MoveFixup, fileSystem: FileSystem) {
  /*
    TODO: Instead of rescanning all files, we can keep track of which files have
    modified between each fixup.
  */

  await indexImportFromFiles(paths, db, repoRoot, true, fileSystem);

  const importers = db.getImportersOfExport(fixup.oldExport.path, fixup.oldExport.name);

  for (const importer of importers) {
    await updateImportDeclarations(importer, repoRoot, fixup, fileSystem);
  }
}


interface UnresolvedImportDecls {
  node: ImportDeclaration;
  moduleSpec: string;
}

async function updateImportDeclarations(importer: string, repoRoot: string, fixup: MoveFixup, fileSystem: FileSystem) {
  const importerSourceFile = await loadSourceFile(importer, fileSystem);
  const unresolvedImports: UnresolvedImportDecls[] = [];
  importerSourceFile.forEachChild((node) => {
    const importDecl = node.asKind(SyntaxKind.ImportDeclaration) as ImportDeclaration;
    if (importDecl) {

      const moduleSpecifier = node.getFirstChildByKind(SyntaxKind.StringLiteral);
      if (!moduleSpecifier) {
        throw new Error('No module specifier found');
      }

      const moduleSpec = moduleSpecifier.getLiteralText();
      unresolvedImports.push({
        node: importDecl,
        moduleSpec,
      });
      return;
    }
  });

  const newImportAliasSpec = await resolveImportSpecAlias(repoRoot, importer, fixup.newExport.path, fileSystem);
  if (!newImportAliasSpec) {
    throw new Error('Failed to resolve import alias for module path ' + fixup.newExport.path + ' referenced from ' + importer);
  }

  let targetUnresolvedImportDecl: ImportDeclaration | null = null;
  for (const unres of unresolvedImports) {
    if (unres.moduleSpec === fixup.oldExport.path) {
      targetUnresolvedImportDecl = unres.node.asKind(SyntaxKind.ImportDeclaration) as ImportDeclaration;
      break;
    }
  }

  for (const unres of unresolvedImports) {
    const resolvedPath = await resolveImportSpec(repoRoot, importer, unres.moduleSpec, fileSystem);
    if (resolvedPath) {
      if (resolvedPath === fixup.oldExport.path) {

        const indexAfter = unres.node.getChildIndex() + 1;
        targetUnresolvedImportDecl = importerSourceFile.insertImportDeclaration(indexAfter, {
          moduleSpecifier: newImportAliasSpec,
        });

        if (!targetUnresolvedImportDecl) {
          console.log('Since we do not have a target unresolved import decl yet, we will create one.');
        }

        if (fixup.oldExport.name === 'default') {
          const oldDefaultImport = unres.node.getDefaultImport();
          if (!oldDefaultImport) {
            throw new Error('No default import found for fixup ' + JSON.stringify(fixup));
          }
          const localDefaultName = oldDefaultImport.getText();

          unres.node.removeDefaultImport();

          targetUnresolvedImportDecl.setDefaultImport(localDefaultName);
        } else {
          const oldNamedImports = unres.node.getNamedImports();
          const oldNamespaceImport = unres.node.getNamespaceImport();

          if (oldNamespaceImport) {
            throw new Error('Namespace imports not supported');
          }

          if (oldNamedImports.length === 0) {
            throw new Error('No named imports found');
          }

          const oldNamedImport = oldNamedImports.find((ni) => ni.getName() === fixup.oldExport.name);
          if (!oldNamedImport) {
            continue;
          }

          const localName = oldNamedImport.getName();
          oldNamedImport.remove();
          if (localName !== fixup.newExport.name) {
            throw new Error('Aliases not supported');
          }

          targetUnresolvedImportDecl.addNamedImport(fixup.newExport.name);
        }


        const oldEmpty = isEmptyImportDecl(unres.node);

        if (oldEmpty) {
          unres.node.remove();
        }


      }
    }

  }

  if (!importerSourceFile.isSaved()) {
    await importerSourceFile.save();
    console.log('M ' + importerSourceFile.getFilePath());
  }
}


function isEmptyImportDecl(imp: ImportDeclaration) {
  if (imp.getDefaultImport()) {
    return false;
  }

  if (imp.getNamedImports().length > 0) {
    return false;
  }

  if (imp.getNamespaceImport()) {
    return false;
  }

  return true;
}
