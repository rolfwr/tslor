/**
 * Replace Type Use Command
 *
 * Proposes replacing all usages of a source type with a target type across the
 * codebase. Produces a `.tslor-plan.json` file that can be reviewed with `diff`
 * and applied with `apply`.
 * Does not verify compilation — a separate tool can handle that concern.
 */

import { openStorage, isObjWithExporterPath, Storage } from './storage';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath, isPathWithinDirectory } from './pathUtils';
import {
  TslorPlan,
  PLAN_VERSION,
  PLAN_FILE_NAME,
  computeStringChecksum,
  writePlan,
  displayPlan,
  ModifyFileChange,
  createEmptyPlan,
} from './plan';
import {
  RepositoryRootProvider,
  InMemoryRepositoryRootProvider,
} from './repositoryRootProvider';
import { FileSystem, extractScript, reinsertScript } from './filesystem';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { dirname, resolve } from 'path';

export interface ReplaceTypeUseOptions {
  sourceType: string;
  sourceModule: string;
  targetType: string;
  targetModule: string;
}

/**
 * Runtime configuration for runReplaceTypeUse.
 */
interface RunReplaceTypeUseConfig {
  debugOptions: DebugOptions;
  fresh: boolean;
  repoProvider: RepositoryRootProvider;
  fileSystem: FileSystem;
  writer: (message: string) => void;
  cwd: string;
}

/**
 * Propose replacing all usages of a source type with a target type.
 *
 * @param config - Runtime dependencies injected at the CLI boundary
 */
export async function runReplaceTypeUse(
  directoryArg: string,
  options: ReplaceTypeUseOptions,
  config: RunReplaceTypeUseConfig,
): Promise<TslorPlan> {
  const { debugOptions, fresh, repoProvider, fileSystem, writer, cwd } = config;
  const isInMemory = repoProvider instanceof InMemoryRepositoryRootProvider;
  const directory = normalizeAndValidatePath(
    directoryArg,
    'Directory',
    isInMemory,
  );

  writer(`Scanning for ${options.sourceType} usages in ${directory}...\n`);

  const repoRoot = repoProvider.findRepositoryRoot(directory);
  const db = openStorage(debugOptions, {
    verbose: true,
    fresh,
    basePath: repoRoot,
    inMemory: isInMemory,
  });
  const allPaths = await repoProvider.getTypeScriptFilePaths(
    repoRoot,
    fileSystem,
  );
  const filteredPaths = allPaths.filter((path: string) =>
    isPathWithinDirectory(path, directory),
  );

  const { indexImportFromFiles } = await import('./indexing');
  await indexImportFromFiles(
    filteredPaths,
    db,
    repoRoot,
    true,
    fileSystem,
    writer,
  );
  db.save();

  const importingFiles = findFilesImportingType(
    db,
    options.sourceType,
    options.sourceModule,
    directory,
  );

  if (importingFiles.size === 0) {
    writer(`No files found importing ${options.sourceType}.\n`);
    return createEmptyPlan('replace-type-use');
  }

  writer(
    `Found ${importingFiles.size} files importing ${options.sourceType}\n`,
  );

  const changes: ModifyFileChange[] = [];
  const undo: ModifyFileChange[] = [];
  const sourceFiles = new Set<string>();
  const checksums: { [filePath: string]: string } = {};

  for (const [filePath, exporterPath] of importingFiles) {
    let originalContent: string;
    try {
      originalContent = await fileSystem.readFile(filePath);
    } catch {
      writer(`  Skipped (not found): ${filePath}\n`);
      continue;
    }
    const modified = replaceTypeInFile(
      filePath,
      originalContent,
      options.sourceType,
      options.targetType,
      options.sourceModule,
      options.targetModule,
      exporterPath,
    );
    if (modified !== null && modified !== originalContent) {
      const fileChecksum = computeStringChecksum(originalContent);
      changes.push({
        type: 'modify-file',
        path: filePath,
        content: modified,
        originalChecksum: fileChecksum,
      });
      undo.push({
        type: 'modify-file',
        path: filePath,
        content: originalContent,
        originalChecksum: computeStringChecksum(modified),
      });
      sourceFiles.add(filePath);
      checksums[filePath] = fileChecksum;
    }
  }

  const plan: TslorPlan = {
    version: PLAN_VERSION,
    command: 'replace-type-use',
    timestamp: new Date().toISOString(),
    sourceFiles: Array.from(sourceFiles),
    targetFiles: [],
    checksums,
    changes,
    undo,
  };

  if (changes.length === 0) {
    writer('No replacements needed.\n');
  } else {
    writer(`Found ${changes.length} files to modify.\n`);
    await writePlan(plan, PLAN_FILE_NAME);
    await displayPlan(plan, {}, cwd, writer);
  }

  return plan;
}

function findFilesImportingType(
  db: Storage,
  sourceType: string,
  sourceModule: string,
  directory: string,
): Map<string, string> {
  const symbolImports = db.getSymbolImports(sourceType);
  const files = new Map<string, string>();

  for (const obj of symbolImports) {
    const id = obj.id;
    const importerPath = id.slice('import|'.length, id.lastIndexOf('|'));

    if (!isPathWithinDirectory(importerPath, directory)) {
      continue;
    }

    if (!isObjWithExporterPath(obj)) {
      continue;
    }
    if (!exporterMatchesSourceModule(obj.exporter.path, sourceModule)) {
      continue;
    }
    files.set(importerPath, obj.exporter.path);
  }

  return files;
}

function shouldReplaceTypeNode(
  node: Node,
  sourceType: string,
  lineIndex: number,
  spliced: boolean,
): boolean {
  if (
    node.getKind() !== SyntaxKind.Identifier ||
    node.getText() !== sourceType
  ) {
    return false;
  }
  const parent = node.getParent();
  if (!parent) {
    return false;
  }
  const parentKind = parent.getKind();
  if (
    parentKind !== SyntaxKind.TypeReference &&
    parentKind !== SyntaxKind.ExpressionWithTypeArguments
  ) {
    return false;
  }
  const lineNum = node.getStartLineNumber() - 1;
  if (lineNum === lineIndex) {
    return false;
  }
  if (spliced && lineNum === lineIndex + 1) {
    return false;
  }
  return true;
}

function replaceTypeReferences(
  scriptText: string,
  sourceType: string,
  targetType: string,
  lineIndex: number,
  spliced: boolean,
): { changed: boolean; fullText: string } {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipLoadingLibFiles: true,
  });
  const sourceFile = project.createSourceFile('temp.ts', scriptText);
  let changed = false;
  sourceFile.forEachDescendant((node) => {
    if (shouldReplaceTypeNode(node, sourceType, lineIndex, spliced)) {
      node.replaceWithText(targetType);
      changed = true;
    }
  });
  return { changed, fullText: sourceFile.getFullText() };
}

function applyImportLineChange(
  lines: string[],
  importInfo: ImportAnalysis,
  sourceType: string,
  targetType: string,
  targetSpec: string,
): void {
  if (importInfo.hasReExport) {
    applyReExportChange(lines, importInfo, sourceType, targetType, targetSpec);
  } else if (importInfo.otherNames.length > 0) {
    const typePrefix = importInfo.importIsTypeOnly ? 'type ' : '';
    lines[importInfo.lineIndex] =
      `import ${typePrefix}{ ${importInfo.otherNames.join(', ')} } from '${importInfo.actualModuleSpec}';`;
    lines.splice(
      importInfo.lineIndex + 1,
      0,
      `import type { ${targetType} } from '${targetSpec}';`,
    );
  } else {
    lines[importInfo.lineIndex] =
      `import type { ${targetType} } from '${targetSpec}';`;
  }
}

/**
 * Update the re-export line (symbol name + module path) and handle the
 * original import: remove it if it carried only the source type, or
 * strip the source type from it if other names are still needed.
 */
function applyReExportChange(
  lines: string[],
  importInfo: ImportAnalysis,
  sourceType: string,
  targetType: string,
  targetSpec: string,
): void {
  // biome-ignore lint/style/noNonNullAssertion: reExportLineIndex is provably in bounds — set during the first-pass scan when hasReExport was flagged.
  const reExportLine = lines[importInfo.reExportLineIndex]!;

  if (importInfo.otherNames.length > 0) {
    /*
      Import is replaced in-place (no splice), so indices don't shift.
      Safe to write re-export first.
    */
    lines[importInfo.reExportLineIndex] = updateReExportLine(
      reExportLine,
      importInfo.actualModuleSpec,
      sourceType,
      targetType,
      targetSpec,
    );
    const typePrefix = importInfo.importIsTypeOnly ? 'type ' : '';
    lines[importInfo.lineIndex] =
      `import ${typePrefix}{ ${importInfo.otherNames.join(', ')} } from '${importInfo.actualModuleSpec}';`;
  } else if (importInfo.lineIndex < importInfo.reExportLineIndex) {
    /*
      Import is removed via splice and sits before the re-export.
      Splice first so the re-export index shifts down, then write.
    */
    lines.splice(importInfo.lineIndex, 1);
    lines[importInfo.reExportLineIndex - 1] = updateReExportLine(
      reExportLine,
      importInfo.actualModuleSpec,
      sourceType,
      targetType,
      targetSpec,
    );
  } else {
    /*
      Import is removed via splice but sits at or after the re-export.
      Write re-export first, then splice — indices of lines before the
      splice point are unaffected.
    */
    lines[importInfo.reExportLineIndex] = updateReExportLine(
      reExportLine,
      importInfo.actualModuleSpec,
      sourceType,
      targetType,
      targetSpec,
    );
    lines.splice(importInfo.lineIndex, 1);
  }
}

function updateReExportLine(
  line: string,
  actualModuleSpec: string,
  sourceType: string,
  targetType: string,
  targetSpec: string,
): string {
  /*
    Split the line at the `from` clause so the sourceType replacement
    cannot match inside the module spec string literal (e.g.,
    `export { Foo } from './Foo'` must not become `export { Bar } from './Bar'`
    before the module spec is replaced).
  */
  const fromIdx = line.search(/\bfrom\b\s+['"]/);
  if (fromIdx < 0) {
    return line;
  }
  const prefix = line.slice(0, fromIdx);
  const fromClause = line.slice(fromIdx);

  const prefixUpdated = prefix.replace(
    new RegExp(`\\b${escapeRegex(sourceType)}\\b`),
    () => targetType,
  );

  /*
    Replace the module spec string literal. Use indexOf + concatenation
    instead of String.replace(str, str) to avoid $-injection: String.replace
    interprets '$&', '$1', etc. in the replacement string as back-references,
    which would corrupt the output if targetSpec contains a '$' character.
  */
  let fromUpdated = fromClause;
  const actualSQ = `'${actualModuleSpec}'`;
  const sqIdx = fromUpdated.indexOf(actualSQ);
  if (sqIdx >= 0) {
    fromUpdated =
      fromUpdated.slice(0, sqIdx) +
      `'${targetSpec}'` +
      fromUpdated.slice(sqIdx + actualSQ.length);
  } else {
    const actualDQ = `"${actualModuleSpec}"`;
    const dqIdx = fromUpdated.indexOf(actualDQ);
    if (dqIdx >= 0) {
      fromUpdated =
        fromUpdated.slice(0, dqIdx) +
        `"${targetSpec}"` +
        fromUpdated.slice(dqIdx + actualDQ.length);
    }
  }
  return prefixUpdated + fromUpdated;
}

export function replaceTypeInFile(
  filePath: string,
  originalContent: string,
  sourceType: string,
  targetType: string,
  sourceModule: string,
  targetModule: string,
  // RATIONALE: options-object conversion deferred (split across multiple functions)
  // ast-grep-ignore: no-optional-param
  resolvedExporterPath?: string,
): string | null {
  const isVue = filePath.endsWith('.vue');
  const scriptContent = isVue
    ? extractScript(originalContent)
    : originalContent;
  if (isVue && !scriptContent.trim()) {
    return null;
  }

  const importInfo = analyzeImports(
    scriptContent,
    sourceType,
    sourceModule,
    filePath,
    resolvedExporterPath,
  );
  if (!importInfo.hasImport) {
    return null;
  }

  const lines = scriptContent.split('\n');

  // Replace the import line
  let lineIndex = importInfo.lineIndex;
  if (lineIndex >= 0) {
    const targetSpec = computeTargetModuleSpec(
      importInfo.actualModuleSpec,
      sourceModule,
      targetModule,
    );
    applyImportLineChange(
      lines,
      importInfo,
      sourceType,
      targetType,
      targetSpec,
    );
  }

  /*
    When hasReExport is true, applyReExportChange either removes the import
    line (splice shifts subsequent lines) or replaces it in-place (sourceType
    is no longer present). Either way, resetting lineIndex prevents
    replaceTypeReferences from skipping the wrong line in the modified content.
  */
  if (importInfo.hasReExport) {
    lineIndex = -1;
  }

  // Replace type references using AST to avoid touching strings/comments
  const spliced = lineIndex >= 0 && importInfo.otherNames.length > 0;
  const { changed: refChanged, fullText } = replaceTypeReferences(
    lines.join('\n'),
    sourceType,
    targetType,
    lineIndex,
    spliced,
  );
  if (refChanged) {
    lines.length = 0;
    lines.push(...fullText.split('\n'));
  }

  const result = lines.join('\n');
  if (result === scriptContent) {
    return null;
  }
  return isVue ? reinsertScript(originalContent, result) : result;
}

interface ImportAnalysis {
  hasImport: boolean;
  importIsTypeOnly: boolean;
  otherNames: string[];
  lineIndex: number;
  hasReExport: boolean;
  reExportLineIndex: number;
  actualModuleSpec: string;
}

function checkModuleSpecMatch(
  moduleSpec: string,
  sourceModule: string,
  importerPath: string | undefined,
  resolvedExporterPath: string | undefined,
): boolean {
  if (moduleSpecMatches(moduleSpec, sourceModule)) {
    return true;
  }
  if (!importerPath || !resolvedExporterPath || !moduleSpec.startsWith('.')) {
    return false;
  }
  if (!exporterMatchesSourceModule(resolvedExporterPath, sourceModule)) {
    return false;
  }
  const resolved = resolve(dirname(importerPath), moduleSpec);
  const exporterBase = resolvedExporterPath.replace(/\.(ts|tsx|js|jsx)$/, '');
  return resolved === exporterBase || resolved === resolvedExporterPath;
}

function analyzeImports(
  script: string,
  sourceType: string,
  sourceModule: string,
  // RATIONALE: options-object conversion deferred (split across multiple functions)
  // ast-grep-ignore: no-optional-param
  importerPath?: string,
  // ast-grep-ignore: no-optional-param
  resolvedExporterPath?: string,
): ImportAnalysis {
  const lines = script.split('\n');
  const result: ImportAnalysis = {
    hasImport: false,
    importIsTypeOnly: false,
    otherNames: [],
    lineIndex: -1,
    hasReExport: false,
    reExportLineIndex: -1,
    actualModuleSpec: '',
  };
  /*
    Match re-exports: export { X } from '...' or export type { X } from '...'.
    Require { or * after export (with optional type keyword) and a quote after
    from. This avoids false positives on lines like:
      export type ItemFromSource = { from: string };
  */
  const reExportPattern = new RegExp(
    `export\\s+(type\\s+)?(\\{[^}]*\\b${escapeRegex(sourceType)}\\b[^}]*\\}|\\*)\\s+from\\s+['"]`,
  );
  const importPattern =
    /^import\s+(type\s+)?{([^}]+)}\s+from\s+['"]([^'"]+)['"]/;
  const normalizeName = (n: string) =>
    // biome-ignore lint/style/noNonNullAssertion: split() always returns at least one element. ast-grep-ignore: no-split-index-assertion
    n.split(/\s+as\s+/)[0]!.replace(/^type\s+/, '');

  // First pass: scan all lines for re-exports (must complete before import break)
  for (const [i, line] of lines.entries()) {
    if (line.match(reExportPattern)) {
      result.hasReExport = true;
      result.reExportLineIndex = i;
    }
  }

  // Second pass: find the import line and break early
  for (const [i, line] of lines.entries()) {
    const importMatch = line.match(importPattern);
    if (!importMatch) {
      continue;
    }
    const [, typeOnlyMatch, namesStr, moduleSpec] = importMatch;
    if (!namesStr || !moduleSpec) {
      continue;
    }
    if (
      !checkModuleSpecMatch(
        moduleSpec,
        sourceModule,
        importerPath,
        resolvedExporterPath,
      )
    ) {
      continue;
    }
    const names = namesStr
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.some((n) => normalizeName(n) === sourceType)) {
      result.hasImport = true;
      result.importIsTypeOnly = Boolean(typeOnlyMatch);
      result.lineIndex = i;
      result.actualModuleSpec = moduleSpec;
      result.otherNames = names.filter((n) => normalizeName(n) !== sourceType);
      break;
    }
  }

  return result;
}

function moduleSpecMatches(actual: string, expected: string): boolean {
  return (
    actual === expected ||
    actual.endsWith('/' + expected) ||
    actual.endsWith(expected)
  );
}

function computeTargetModuleSpec(
  actualSpec: string,
  sourceModule: string,
  targetModule: string,
): string {
  if (sourceModule === targetModule) {
    return actualSpec;
  }
  if (!targetModule.startsWith('.')) {
    return targetModule;
  }
  const sourceBare = sourceModule.replace(/^\.\//, '');
  const targetBare = targetModule.replace(/^\.\//, '');
  if (actualSpec.endsWith(sourceBare)) {
    let prefix = actualSpec.slice(0, -sourceBare.length);
    if (prefix === '' && actualSpec.startsWith('./')) {
      prefix = './';
    }
    return prefix + targetBare;
  }
  return targetModule;
}

function exporterMatchesSourceModule(
  exporterPath: string,
  sourceModule: string,
): boolean {
  if (sourceModule.startsWith('.')) {
    return true;
  }
  const parts = sourceModule.split('/');
  const firstPart = parts.at(0);
  if (firstPart === undefined) {
    return false;
  }
  const pathPortion = firstPart.startsWith('@')
    ? parts.slice(2).join('/')
    : parts.slice(1).join('/');
  if (!pathPortion) {
    return true;
  }
  const exporterBase = exporterPath.replace(/\.(ts|tsx|js|jsx)$/, '');
  return exporterBase.endsWith('/' + pathPortion);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
