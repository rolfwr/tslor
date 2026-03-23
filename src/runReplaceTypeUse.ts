/**
 * Replace Type Use Command
 *
 * Replaces all usages of a source type with a target type across the codebase.
 * Does not verify compilation — a separate tool can handle that concern.
 */

import { openStorage } from "./storage";
import { DebugOptions } from "./objstore";
import { normalizeAndValidatePath } from "./pathUtils";
import { promises as fsp } from "fs";
import { extractScript, reinsertScript } from "./transformingFileSystem";
import { RepositoryRootProvider, InMemoryRepositoryRootProvider } from "./repositoryRootProvider";
import { FileSystem } from "./filesystem";
import { Project, SyntaxKind } from "ts-morph";

export interface ReplaceTypeUseOptions {
  sourceType: string;
  sourceModule: string;
  targetType: string;
  targetModule: string;
}

export async function runReplaceTypeUse(
  directoryArg: string,
  options: ReplaceTypeUseOptions,
  debugOptions: DebugOptions,
  repoProvider: RepositoryRootProvider,
  fileSystem: FileSystem
): Promise<void> {
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;
  const directory = normalizeAndValidatePath(directoryArg, "Directory", isInMemory);

  console.log(`Scanning for ${options.sourceType} usages in ${directory}...`);

  const repoRoot = repoProvider.findRepositoryRoot(directory);
  const db = openStorage(debugOptions, true);
  const allPaths = await repoProvider.getTypeScriptFilePaths(repoRoot, true);
  const filteredPaths = allPaths.filter((path: string) => path.startsWith(directory));

  const { indexImportFromFiles } = await import('./indexing');
  await indexImportFromFiles(filteredPaths, db, repoRoot, true, fileSystem);
  db.save();

  const importingFiles = findFilesImportingType(db, options.sourceType, options.sourceModule, directory);

  if (importingFiles.size === 0) {
    console.log(`No files found importing ${options.sourceType}.`);
    return;
  }

  console.log(`Found ${importingFiles.size} files importing ${options.sourceType}`);

  let modifiedCount = 0;
  for (const filePath of importingFiles) {
    let originalContent: string;
    try {
      originalContent = await fsp.readFile(filePath, 'utf-8');
    } catch {
      console.log(`  Skipped (not found): ${filePath}`);
      continue;
    }
    const modified = replaceTypeInFile(
      filePath, originalContent,
      options.sourceType, options.targetType,
      options.sourceModule, options.targetModule
    );
    if (modified !== null && modified !== originalContent) {
      await fsp.writeFile(filePath, modified, 'utf-8');
      console.log(`  Modified: ${filePath}`);
      modifiedCount++;
    }
  }

  console.log(`\nDone. Modified ${modifiedCount} files.`);
}

function findFilesImportingType(db: ReturnType<typeof openStorage>, sourceType: string, sourceModule: string, directory: string): Set<string> {
  const symbolImports = db.getSymbolImports(sourceType);
  const files = new Set<string>();
  const directoryPrefix = directory.endsWith('/') ? directory : directory + '/';

  for (const obj of symbolImports) {
    const id = obj.id;
    const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));

    if (!importerPath.startsWith(directoryPrefix)) {
      continue;
    }

    const exporter = obj.exporter as { path?: string; spec?: string } | undefined;
    if (exporter && 'path' in exporter && typeof exporter.path === 'string') {
      files.add(importerPath);
    }
  }

  return files;
}

export function replaceTypeInFile(
  filePath: string,
  originalContent: string,
  sourceType: string,
  targetType: string,
  sourceModule: string,
  targetModule: string
): string | null {
  const isVue = filePath.endsWith('.vue');
  let scriptContent: string;
  if (isVue) {
    scriptContent = extractScript(originalContent);
    if (!scriptContent.trim()) return null;
  } else {
    scriptContent = originalContent;
  }

  const importInfo = analyzeImports(scriptContent, sourceType, sourceModule);
  if (!importInfo.hasImport) return null;

  const lines = scriptContent.split('\n');
  let changed = false;

  // Replace the import line
  if (importInfo.lineIndex >= 0) {
    if (importInfo.hasReExport) {
      // Re-export present — keep original import, add new import line after it
      const newImportLine = `import type { ${targetType} } from '${targetModule}';`;
      lines.splice(importInfo.lineIndex + 1, 0, newImportLine);
      changed = true;
    } else if (importInfo.otherNames.length > 0) {
      // Shared import — remove source type, add new import
      const typePrefix = importInfo.isTypeOnly ? 'type ' : '';
      lines[importInfo.lineIndex] = `import ${typePrefix}{ ${importInfo.otherNames.join(', ')} } from '${sourceModule}';`;
      const newImportLine = `import type { ${targetType} } from '${targetModule}';`;
      lines.splice(importInfo.lineIndex + 1, 0, newImportLine);
      changed = true;
    } else {
      // Sole import — replace entirely
      lines[importInfo.lineIndex] = `import type { ${targetType} } from '${targetModule}';`;
      changed = true;
    }
  }

  // Replace type references using AST to avoid touching strings/comments
  const spliced = changed && (importInfo.otherNames.length > 0 || importInfo.hasReExport);
  const scriptText = lines.join('\n');
  const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
  const sourceFile = project.createSourceFile('temp.ts', scriptText);

  sourceFile.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.Identifier && node.getText() === sourceType) {
      const parent = node.getParent();
      if (!parent) return;
      const parentKind = parent.getKind();
      if (parentKind !== SyntaxKind.TypeReference && parentKind !== SyntaxKind.ExpressionWithTypeArguments) return;
      const lineNum = node.getStartLineNumber() - 1; // 0-based
      if (lineNum === importInfo.lineIndex) return;
      if (spliced && lineNum === importInfo.lineIndex + 1) return;
      node.replaceWithText(targetType);
      changed = true;
    }
  });

  if (changed) {
    const updatedLines = sourceFile.getFullText().split('\n');
    lines.length = 0;
    lines.push(...updatedLines);
  }

  if (!changed) return null;

  const result = lines.join('\n');
  if (isVue) {
    return reinsertScript(originalContent, result);
  }
  return result;
}

interface ImportAnalysis {
  hasImport: boolean;
  isTypeOnly: boolean;
  otherNames: string[];
  importLine: string;
  lineIndex: number;
  hasReExport: boolean;
}

function analyzeImports(script: string, sourceType: string, sourceModule: string): ImportAnalysis {
  const lines = script.split('\n');
  const result: ImportAnalysis = {
    hasImport: false,
    isTypeOnly: false,
    otherNames: [],
    importLine: '',
    lineIndex: -1,
    hasReExport: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.match(new RegExp(`export\\s+.*\\b${escapeRegex(sourceType)}\\b.*from\\s`))) {
      result.hasReExport = true;
    }

    const importMatch = line.match(/^import\s+(type\s+)?{([^}]+)}\s+from\s+['"]([^'"]+)['"]/);
    if (!importMatch) continue;

    const isTypeOnly = !!importMatch[1];
    const namesStr = importMatch[2];
    const moduleSpec = importMatch[3];

    if (!moduleSpecMatches(moduleSpec, sourceModule)) continue;

    const names = namesStr.split(',').map(n => n.trim()).filter(Boolean);
    const hasSourceType = names.some(n => {
      const baseName = n.split(/\s+as\s+/)[0].trim();
      return baseName === sourceType;
    });

    if (hasSourceType) {
      result.hasImport = true;
      result.isTypeOnly = isTypeOnly;
      result.importLine = line;
      result.lineIndex = i;
      result.otherNames = names.filter(n => {
        const baseName = n.split(/\s+as\s+/)[0].trim();
        return baseName !== sourceType;
      });
      break;
    }
  }

  return result;
}

function moduleSpecMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (actual.endsWith('/' + expected) || actual.endsWith(expected)) return true;
  return false;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
