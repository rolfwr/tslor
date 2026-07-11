/**
 * Split Module Refactoring Primitives
 *
 * This module provides the core functionality for splitting TypeScript modules
 * by extracting symbols and their dependencies into new modules.
 */

import path from 'node:path';
import {
  ClassDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  JSDoc,
  Node,
  Project,
  SourceFile,
  SyntaxKind,
  TypeAliasDeclaration,
  VariableStatement,
} from 'ts-morph';
import { CliError } from './errors';
import { getModuleBindingSet } from './sealedBinder';
import { ImportUsage, StaticModuleInfo } from './staticAnalysis';

/**
 * Represents the dependency relationships within a module
 */
export interface IntraModuleDependencies {
  exports: Set<string>; // Exported symbols
  definitions: Set<string>; // All defined symbols (exported + internal)
  dependencies: Map<string, Set<string>>; // symbol -> set of symbols it depends on
}

/**
 * Result of analyzing what needs to be moved when splitting a symbol
 */
export interface SplitAnalysis {
  symbolToMove: string;
  requiredDependencies: Set<string>; // Internal symbols that must move with it
  circularDependencies: string[]; // Symbols involved in circular deps
  canSplit: boolean; // Whether split is possible
}

/**
 * Symbol definition extracted from source code using AST nodes
 */
export interface SymbolDefinition {
  name: string;
  kind: 'function' | 'variable' | 'type' | 'class' | 'interface' | 'const';
  node:
    | FunctionDeclaration
    | VariableStatement
    | TypeAliasDeclaration
    | InterfaceDeclaration
    | ClassDeclaration;
  jsDocs?: JSDoc[];
  isExported: boolean;
  startPos: number; // For debugging/verification
  endPos: number;
}

/**
 * Required import for the new module
 */
export interface RequiredImport {
  moduleSpec: string; // './utils' or 'lodash'
  importedNames: string[]; // ['helper', 'validator'] (empty for default imports)
  isTypeOnly: boolean;
  defaultImport?: string; // If present, this is a default import with this local name
}

/**
 * Classify a name: is it a local module declaration (not an import, not ambient)?
 *
 * Uses elimination against the module-scope binding set: a name is a local
 * declaration only if it is bound at module scope AND is not an import.
 * Everything else (unbound references) is ambient and excluded.
 */
function isLocalDeclaration(
  name: string,
  moduleInfo: StaticModuleInfo,
  moduleBindings: Set<string>,
): boolean {
  if (!moduleBindings.has(name)) {
    return false;
  }
  if (moduleInfo.unresolvedExportsByImportNames.has(name)) {
    return false;
  }
  return true;
}

/**
 * Build a clean dependency graph from parsed module info.
 *
 * Uses elimination semantics: a name is a local declaration if and only if it
 * is bound at module scope (per the binding set derived from the TypeScript
 * binder) and is not an import. Ambient names are excluded regardless of
 * whether they resolve in the target environment.
 *
 * @param moduleInfo - Parsed static module info from {@link parseModule}.
 * @param sourceText - Source text of the module, used to compute the
 *                     module-scope binding set via the sealed binder.
 */
export function buildIntraModuleDependencies(
  moduleInfo: StaticModuleInfo,
  sourceText: string,
): IntraModuleDependencies {
  const moduleBindings = getModuleBindingSet(sourceText, {});

  const allDefinedSymbols = new Set<string>();

  for (const symbol of moduleInfo.identifierUses.keys()) {
    if (isLocalDeclaration(symbol, moduleInfo, moduleBindings)) {
      allDefinedSymbols.add(symbol);
    }
  }
  for (const symbol of moduleInfo.exportedNames) {
    allDefinedSymbols.add(symbol);
  }

  const dependencies = new Map<string, Set<string>>();

  for (const [symbol, uses] of moduleInfo.identifierUses) {
    if (!isLocalDeclaration(symbol, moduleInfo, moduleBindings)) {
      continue;
    }
    const cleanDeps = new Set<string>();

    for (const usedSymbol of uses) {
      if (isLocalDeclaration(usedSymbol, moduleInfo, moduleBindings)) {
        cleanDeps.add(usedSymbol);
        allDefinedSymbols.add(usedSymbol);
      }
    }

    if (cleanDeps.size > 0) {
      dependencies.set(symbol, cleanDeps);
    }
  }

  return {
    exports: moduleInfo.exportedNames,
    definitions: allDefinedSymbols,
    dependencies,
  };
}

/**
 * Compute transitive closure of dependencies for a given symbol
 */
export function computeTransitiveDependencies(
  deps: IntraModuleDependencies,
  symbol: string,
): Set<string> {
  const result = new Set<string>();
  const visiting = new Set<string>();

  function visit(sym: string): void {
    if (result.has(sym) || visiting.has(sym)) {
      return;
    }

    visiting.add(sym);
    const directDeps = deps.dependencies.get(sym) || new Set();

    for (const dep of directDeps) {
      visit(dep);
      result.add(dep);
    }

    visiting.delete(sym);
  }

  visit(symbol);
  return result;
}

/**
 * Detect circular dependencies in the module
 */
export function detectCircularDependencies(
  deps: IntraModuleDependencies,
): string[][] {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(symbol: string, path: string[]): void {
    if (recursionStack.has(symbol)) {
      // Found a cycle
      const cycleStart = path.indexOf(symbol);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }

    if (visited.has(symbol)) {
      return;
    }

    visited.add(symbol);
    recursionStack.add(symbol);

    const directDeps = deps.dependencies.get(symbol) || new Set();
    for (const dep of directDeps) {
      dfs(dep, [...path, dep]);
    }

    recursionStack.delete(symbol);
  }

  for (const symbol of deps.definitions) {
    if (!visited.has(symbol)) {
      dfs(symbol, [symbol]);
    }
  }

  return cycles;
}

/**
 * Analyze what needs to be moved when splitting out a symbol
 */
export function analyzeSplit(
  deps: IntraModuleDependencies,
  targetSymbol: string,
): SplitAnalysis {
  if (!deps.exports.has(targetSymbol)) {
    throw new Error(`Symbol '${targetSymbol}' is not exported`);
  }

  const allTransitiveDeps = computeTransitiveDependencies(deps, targetSymbol);

  /*
    Filter to only include dependencies that are actually defined in this module
    (exclude imported symbols).
  */
  const requiredDeps = new Set<string>();
  for (const dep of allTransitiveDeps) {
    if (deps.definitions.has(dep)) {
      requiredDeps.add(dep);
    }
  }

  const cycles = detectCircularDependencies(deps);

  // Check if any of the required dependencies are involved in cycles
  const involvedInCycle: string[] = [];
  for (const cycle of cycles) {
    for (const symbol of cycle) {
      if (requiredDeps.has(symbol) || symbol === targetSymbol) {
        involvedInCycle.push(...cycle);
      }
    }
  }

  return {
    symbolToMove: targetSymbol,
    requiredDependencies: requiredDeps,
    circularDependencies: involvedInCycle,
    canSplit: involvedInCycle.length === 0, // Can only split if no circular deps
  };
}

/**
 * Extract symbol definitions from TypeScript source using AST nodes
 */
export function extractSymbolDefinitions(
  sourceFile: SourceFile,
  symbolNames: Set<string>,
): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = [];

  // Find function declarations
  sourceFile.getFunctions().forEach((func) => {
    const name = func.getName();
    if (name && symbolNames.has(name)) {
      definitions.push({
        name,
        kind: 'function',
        node: func,
        jsDocs: func.getJsDocs(),
        isExported: func.hasModifier(SyntaxKind.ExportKeyword),
        startPos: func.getStart(),
        endPos: func.getEnd(),
      });
    }
  });

  // Find variable declarations (const, let, var)
  sourceFile.getVariableStatements().forEach((stmt) => {
    stmt.getDeclarations().forEach((decl) => {
      const name = decl.getName();
      if (symbolNames.has(name)) {
        definitions.push({
          name,
          kind: stmt.getDeclarationKind() === 'const' ? 'const' : 'variable',
          node: stmt,
          jsDocs: stmt.getJsDocs(),
          isExported: stmt.hasModifier(SyntaxKind.ExportKeyword),
          startPos: stmt.getStart(),
          endPos: stmt.getEnd(),
        });
      }
    });
  });

  // Find type aliases
  sourceFile.getTypeAliases().forEach((type) => {
    const name = type.getName();
    if (symbolNames.has(name)) {
      definitions.push({
        name,
        kind: 'type',
        node: type,
        jsDocs: type.getJsDocs(),
        isExported: type.hasModifier(SyntaxKind.ExportKeyword),
        startPos: type.getStart(),
        endPos: type.getEnd(),
      });
    }
  });

  // Find interfaces
  sourceFile.getInterfaces().forEach((iface) => {
    const name = iface.getName();
    if (symbolNames.has(name)) {
      definitions.push({
        name,
        kind: 'interface',
        node: iface,
        jsDocs: iface.getJsDocs(),
        isExported: iface.hasModifier(SyntaxKind.ExportKeyword),
        startPos: iface.getStart(),
        endPos: iface.getEnd(),
      });
    }
  });

  // Find classes
  sourceFile.getClasses().forEach((cls) => {
    const name = cls.getName();
    if (name && symbolNames.has(name)) {
      definitions.push({
        name,
        kind: 'class',
        node: cls,
        jsDocs: cls.getJsDocs(),
        isExported: cls.hasModifier(SyntaxKind.ExportKeyword),
        startPos: cls.getStart(),
        endPos: cls.getEnd(),
      });
    }
  });

  return definitions;
}

/**
 * Fail-fast invariant: every symbol scheduled for extraction or import
 * generation must have an actual module-scope declaration.
 *
 * This guarantee is not compiler-provable because the dependency graph
 * is built from `identifierUses` (static AST references), which may
 * include leaked inner-scope names that shadow a module-scope binding.
 * Although elimination semantics exclude ambient names, a leaked local
 * whose name shadows a module-scope binding is still misattributed as a
 * use of that binding. The compiler would need full scope
 * analysis to distinguish them, but the split pipeline deliberately
 * avoids checker-level resolution. Therefore a runtime check validates
 * that the pipeline's assumptions about declarations hold before
 * generating output.
 *
 * @param sourceFile - The source file to check declarations against.
 * @param symbolsToCheck - Names that must have module-scope declarations.
 * @param moduleLabel - Human-readable label for error messages.
 * @throws CliError naming each undeclared symbol and the module.
 */
export function validateSymbolsHaveDeclarations(
  sourceFile: SourceFile,
  symbolsToCheck: Set<string>,
  moduleLabel: string,
): void {
  if (symbolsToCheck.size === 0) {
    return;
  }

  const declarations = extractSymbolDefinitions(sourceFile, symbolsToCheck);
  const found = new Set(declarations.map((def) => def.name));
  const missing = [...symbolsToCheck].filter((name) => !found.has(name));

  if (missing.length > 0) {
    throw new CliError(
      `Cannot split module: the following symbols have no declaration in ${moduleLabel}: ${missing.join(', ')}`,
      {},
    );
  }
}

/**
 * Find imports that are only used by specific symbols
 */
export function findImportsOnlyUsedBySymbols(
  importUsages: ImportUsage[],
  targetSymbols: Set<string>,
): Set<string> {
  const importsUsedByTarget = new Set<string>();
  const importsUsedByOthers = new Set<string>();

  for (const usage of importUsages) {
    const isTargetSymbol = targetSymbols.has(usage.symbol);

    for (const imp of usage.usesImports) {
      const importKey = `${imp.moduleSpec}:${imp.importedName}`;

      if (isTargetSymbol) {
        importsUsedByTarget.add(importKey);
      } else {
        importsUsedByOthers.add(importKey);
      }
    }
  }

  // Return imports used by target symbols but NOT by other symbols
  const onlyUsedByTarget = new Set<string>();
  for (const importKey of importsUsedByTarget) {
    if (!importsUsedByOthers.has(importKey)) {
      onlyUsedByTarget.add(importKey);
    }
  }

  return onlyUsedByTarget;
}

/**
 * Find non-exported symbols that are moved to the target module but are also
 * referenced by symbols staying in the source module. These must be exported
 * from the target and imported back into the source.
 */
export function findSharedNonExportedDeps(
  deps: IntraModuleDependencies,
  symbolsToMove: Set<string>,
): Set<string> {
  const shared = new Set<string>();
  for (const [symbol, symbolDeps] of deps.dependencies) {
    if (symbolsToMove.has(symbol)) {
      continue;
    }
    for (const dep of symbolDeps) {
      if (symbolsToMove.has(dep) && !deps.exports.has(dep)) {
        shared.add(dep);
      }
    }
  }
  return shared;
}

/**
 * Adjust a module specifier from source file's perspective to target file's perspective
 */
function adjustModuleSpecForNewLocation(
  moduleSpec: string,
  sourceFilePath: string,
  targetFilePath: string,
): string {
  // Only adjust relative imports (starting with ./ or ../)
  if (!moduleSpec.startsWith('.')) {
    return moduleSpec;
  }

  // Resolve the module spec from the source file's location to get the absolute path
  const sourceDir = path.dirname(sourceFilePath);
  const resolvedPath = path.resolve(sourceDir, moduleSpec);

  // Calculate the relative path from the target file's location
  const targetDir = path.dirname(targetFilePath);
  let relativePath = path.relative(targetDir, resolvedPath);

  // Normalize path separators for cross-platform compatibility
  relativePath = relativePath.replace(/\\/g, '/');

  // Ensure the path starts with ./ or ../
  if (!relativePath.startsWith('.')) {
    relativePath = './' + relativePath;
  }

  return relativePath;
}

/**
 * Generate import statements for the new module based on symbol usage
 */
type ImportMapEntry = {
  namedImports: Set<string>;
  defaultImport?: string;
  isTypeOnly: boolean;
};

function addImportToMap(
  requiredImportsMap: Map<string, ImportMapEntry>,
  imp: {
    moduleSpec: string;
    importedName: string;
    isTypeOnly: boolean;
    isDefault: boolean;
  },
): void {
  let entry = requiredImportsMap.get(imp.moduleSpec);
  if (!entry) {
    entry = { namedImports: new Set(), isTypeOnly: imp.isTypeOnly };
    requiredImportsMap.set(imp.moduleSpec, entry);
  }
  if (imp.isDefault) {
    entry.defaultImport = imp.importedName;
  } else {
    entry.namedImports.add(imp.importedName);
  }
  if (!imp.isTypeOnly) {
    entry.isTypeOnly = false;
  }
}

export function computeRequiredImports(
  symbolDefinitions: SymbolDefinition[],
  importUsages: ImportUsage[],
  // RATIONALE: options-object conversion deferred (part of larger split refactoring)
  // ast-grep-ignore: no-optional-param
  sourceFilePath?: string,
  // ast-grep-ignore: no-optional-param
  targetFilePath?: string,
): RequiredImport[] {
  const requiredImportsMap = new Map<string, ImportMapEntry>();
  const movedSymbolNames = new Set(symbolDefinitions.map((def) => def.name));

  for (const usage of importUsages) {
    if (!movedSymbolNames.has(usage.symbol)) {
      continue;
    }
    /*
      Include all imports from moved symbols. The new module needs every import
      that moved symbols reference, whether exclusively used or shared with
      non-moved symbols.
    */
    for (const imp of usage.usesImports) {
      addImportToMap(requiredImportsMap, imp);
    }
  }

  return Array.from(requiredImportsMap.entries()).map(([moduleSpec, info]) => {
    const adjustedModuleSpec =
      sourceFilePath && targetFilePath
        ? adjustModuleSpecForNewLocation(
            moduleSpec,
            sourceFilePath,
            targetFilePath,
          )
        : moduleSpec;
    return {
      moduleSpec: adjustedModuleSpec,
      importedNames: Array.from(info.namedImports).sort(),
      isTypeOnly: info.isTypeOnly,
      ...(info.defaultImport !== undefined && {
        defaultImport: info.defaultImport,
      }),
    };
  });
}

/**
 * If the statement declares a symbol matching `exportNames`, export it.
 */
function exportStatementIfNeeded(stmt: Node, exportNames: Set<string>): void {
  if (Node.isVariableStatement(stmt)) {
    const name = stmt.getDeclarations()[0]?.getName();
    if (name && exportNames.has(name)) {
      stmt.setIsExported(true);
    }
  } else if (
    Node.isFunctionDeclaration(stmt) ||
    Node.isClassDeclaration(stmt)
  ) {
    const name = stmt.getName();
    if (name && exportNames.has(name)) {
      stmt.setIsExported(true);
    }
  } else if (
    Node.isTypeAliasDeclaration(stmt) ||
    Node.isInterfaceDeclaration(stmt)
  ) {
    const name = stmt.getName();
    if (exportNames.has(name)) {
      stmt.setIsExported(true);
    }
  }
}

function addImportStructureToFile(
  newFile: SourceFile,
  imp: RequiredImport,
): void {
  const base = {
    moduleSpecifier: imp.moduleSpec,
    ...(imp.isTypeOnly ? { isTypeOnly: true } : {}),
  };
  if (imp.defaultImport && imp.importedNames.length > 0) {
    newFile.addImportDeclaration({ ...base, defaultImport: imp.defaultImport });
    newFile.addImportDeclaration({ ...base, namedImports: imp.importedNames });
  } else if (imp.defaultImport) {
    newFile.addImportDeclaration({ ...base, defaultImport: imp.defaultImport });
  } else if (imp.importedNames.length > 0) {
    newFile.addImportDeclaration({ ...base, namedImports: imp.importedNames });
  }
}

export function generateNewModuleSource(
  symbolDefinitions: SymbolDefinition[],
  requiredImports: RequiredImport[],
  // RATIONALE: options-object conversion deferred (part of larger split refactoring)
  // ast-grep-ignore: no-optional-param
  additionalExports?: Set<string>,
): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const newFile = project.createSourceFile('new-module.ts', '');

  for (const imp of requiredImports) {
    addImportStructureToFile(newFile, imp);
  }

  /*
    Add symbol definitions by inserting their full AST text.
    This preserves everything: methods, properties, comments, JSDoc, formatting, etc.
  */
  const sortedDefinitions = symbolDefinitions.sort(
    (a, b) => a.startPos - b.startPos,
  );

  for (const def of sortedDefinitions) {
    // Get the full text of the node including JSDoc comments and all members
    const fullText = def.node.getFullText();
    newFile.addStatements(fullText);
  }

  // Export symbols that need to be shared back to the source module
  if (additionalExports && additionalExports.size > 0) {
    for (const stmt of newFile.getStatements()) {
      exportStatementIfNeeded(stmt, additionalExports);
    }
  }

  return newFile.getFullText();
}

/**
 * Remove symbol definitions from source code.
 *
 * @param sourceCode - TypeScript source code string.
 * @param symbolsToRemove - Set of symbol names to remove.
 * @returns Source code with the specified symbols removed.
 */
export function removeSymbolsFromSource(
  sourceCode: string,
  symbolsToRemove: Set<string>,
): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.ts', sourceCode);

  /*
    Use replaceWithText('') instead of remove() to preserve leading trivia
    (blank lines between declarations). remove() eats leading trivia;
    replaceWithText('') replaces from getStart(true) to getEnd(), keeping
    the whitespace that separated this node from the previous one.
  */

  // Remove function declarations
  sourceFile.getFunctions().forEach((func) => {
    const name = func.getName();
    if (name && symbolsToRemove.has(name)) {
      func.replaceWithText('');
    }
  });

  // Temp project used to generate replacement text for partial variable
  // statement removal without leaving a dangling statement in sourceFile.
  const tempProject = new Project({ useInMemoryFileSystem: true });
  const tempSourceFile = tempProject.createSourceFile('temp.ts', '');

  // Remove variable statements
  sourceFile.getVariableStatements().forEach((stmt) => {
    const declarations = stmt.getDeclarations();
    const declarationsToKeep = declarations.filter(
      (decl) => !symbolsToRemove.has(decl.getName()),
    );

    if (declarationsToKeep.length === 0) {
      // Remove entire statement if all declarations are being removed
      stmt.replaceWithText('');
    } else if (declarationsToKeep.length < declarations.length) {
      const kind = stmt.getDeclarationKind();
      const isExported = stmt.hasModifier(SyntaxKind.ExportKeyword);

      const newDeclarations = declarationsToKeep.map((decl) => {
        const name = decl.getName();
        const typeNode = decl.getTypeNode();
        const initializer = decl.getInitializer();
        return {
          name,
          ...(typeNode && { type: typeNode.getText() }),
          ...(initializer && { initializer: initializer.getText() }),
        };
      });

      // Generate replacement text in an isolated project so we don't
      // leave a dangling statement in the working sourceFile.
      const tempStmt = tempSourceFile.addVariableStatement({
        declarationKind: kind,
        isExported,
        declarations: newDeclarations,
      });
      const replacementText = tempStmt.getFullText();
      stmt.replaceWithText(replacementText);
      tempStmt.remove();
    }
  });

  // Remove type aliases
  sourceFile.getTypeAliases().forEach((type) => {
    const name = type.getName();
    if (symbolsToRemove.has(name)) {
      type.replaceWithText('');
    }
  });

  // Remove interfaces
  sourceFile.getInterfaces().forEach((iface) => {
    const name = iface.getName();
    if (symbolsToRemove.has(name)) {
      iface.replaceWithText('');
    }
  });

  // Remove classes
  sourceFile.getClasses().forEach((cls) => {
    const name = cls.getName();
    if (name && symbolsToRemove.has(name)) {
      cls.replaceWithText('');
    }
  });

  // Collapse extra blank lines left by replaceWithText('') to single blank lines
  let result = sourceFile.getFullText();
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

/**
 * Remove unused imports from source code.
 *
 * @param sourceCode - TypeScript source code string.
 * @param onlyUsedByRemovedSymbols - Set of import keys ("moduleSpec:name") to remove.
 * @returns Source code with the specified imports removed.
 */
export function removeUnusedImports(
  sourceCode: string,
  onlyUsedByRemovedSymbols: Set<string>,
): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.ts', sourceCode);

  // Remove import declarations that are only used by removed symbols
  sourceFile.getImportDeclarations().forEach((importDecl) => {
    const moduleSpec = importDecl.getModuleSpecifierValue();

    // Check default import
    const defaultImport = importDecl.getDefaultImport();
    const defaultImportText = defaultImport?.getText();
    const shouldRemoveDefault =
      defaultImport &&
      onlyUsedByRemovedSymbols.has(`${moduleSpec}:${defaultImportText}`);

    // Check namespace import
    const namespaceImport = importDecl.getNamespaceImport();
    const shouldRemoveNamespace =
      namespaceImport &&
      onlyUsedByRemovedSymbols.has(
        `${moduleSpec}:${namespaceImport.getText()}`,
      );

    // Check named imports
    const namedImports = importDecl.getNamedImports();
    const importsToKeep = namedImports.filter((namedImport) => {
      const importName = namedImport.getName();
      const importKey = `${moduleSpec}:${importName}`;
      return !onlyUsedByRemovedSymbols.has(importKey);
    });

    // Determine if entire import should be removed
    const hasNoNamedImports = namedImports.length === 0;
    const hasNoKeptNamedImports = importsToKeep.length === 0;
    const shouldRemoveEntireImport =
      (hasNoNamedImports && (shouldRemoveDefault || shouldRemoveNamespace)) ||
      (!hasNoNamedImports &&
        hasNoKeptNamedImports &&
        !defaultImport &&
        !namespaceImport);

    if (shouldRemoveEntireImport) {
      // Remove entire import declaration
      importDecl.remove();
    } else if (importsToKeep.length < namedImports.length) {
      // Some named imports removed - reconstruct the import
      const keptImportNames = importsToKeep
        .map((imp) => imp.getName())
        .join(', ');
      const newImportText = `import { ${keptImportNames} } from '${moduleSpec}';`;
      importDecl.replaceWithText(newImportText);
    }
  });

  return sourceFile.getFullText();
}

/**
 * Classify symbols into types and values based on their definitions
 */
function classifySymbolsByKind(
  symbols: Set<string>,
  // RATIONALE: options-object conversion deferred (part of larger split refactoring)
  // ast-grep-ignore: no-optional-param
  symbolDefinitions?: SymbolDefinition[],
): { typeSymbols: Set<string>; valueSymbols: Set<string> } {
  const typeSymbols = new Set<string>();
  const valueSymbols = new Set<string>();

  if (symbolDefinitions) {
    const defMap = new Map(symbolDefinitions.map((d) => [d.name, d]));
    for (const symbol of symbols) {
      const def = defMap.get(symbol);
      if (def) {
        if (def.kind === 'type' || def.kind === 'interface') {
          typeSymbols.add(symbol);
        } else {
          valueSymbols.add(symbol);
        }
      } else {
        // If we don't have definition info, assume it's a value for safety
        valueSymbols.add(symbol);
      }
    }
  } else {
    // Fallback: treat all as values if we don't have type information
    symbols.forEach((s) => valueSymbols.add(s));
  }

  return { typeSymbols, valueSymbols };
}

/**
 * Find which symbols are actually referenced in the source file
 */
function findReferencedSymbols(
  sourceFile: SourceFile,
  candidateSymbols: Set<string>,
): Set<string> {
  const referencedSymbols = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.Identifier) {
      // Skip property names in object literal assignments (non-shorthand)
      const parent = node.getParent();
      if (parent && parent.getKind() === SyntaxKind.PropertyAssignment) {
        const propAssignment = parent.asKindOrThrow(
          SyntaxKind.PropertyAssignment,
        );
        if (propAssignment.getNameNode() === node) {
          return;
        }
      }

      const identifierText = node.getText();
      if (candidateSymbols.has(identifierText)) {
        referencedSymbols.add(identifierText);
      }
    }
  });

  return referencedSymbols;
}

/**
 * Add import declarations for symbols
 */
function addImportDeclarations(
  sourceFile: SourceFile,
  typeSymbols: Set<string>,
  valueSymbols: Set<string>,
  modulePath: string,
): void {
  if (typeSymbols.size > 0) {
    const typeNames = Array.from(typeSymbols).sort().join(', ');
    const typeImportStatement = `import type { ${typeNames} } from '${modulePath}';`;
    sourceFile.insertText(0, typeImportStatement + '\n');
  }

  if (valueSymbols.size > 0) {
    const valueNames = Array.from(valueSymbols).sort().join(', ');
    const valueImportStatement = `import { ${valueNames} } from '${modulePath}';`;
    sourceFile.insertText(0, valueImportStatement + '\n');
  }
}

/**
 * Add re-export declarations for symbols
 */
function addReExportDeclarations(
  sourceFile: SourceFile,
  typeSymbols: Set<string>,
  valueSymbols: Set<string>,
  modulePath: string,
): void {
  if (typeSymbols.size > 0) {
    sourceFile.addExportDeclaration({
      moduleSpecifier: modulePath,
      namedExports: Array.from(typeSymbols).sort(),
      isTypeOnly: true,
    });
  }

  if (valueSymbols.size > 0) {
    sourceFile.addExportDeclaration({
      moduleSpecifier: modulePath,
      namedExports: Array.from(valueSymbols).sort(),
    });
  }
}

/**
 * Add import (and optionally re-export) declarations for moved symbols.
 *
 * @param sourceCode - TypeScript source code string.
 * @param movedSymbols - Set of symbol names that were moved.
 * @param newModulePath - Import path for the new module (e.g. "./target").
 * @param shouldReExport - Whether to add re-export declarations.
 * @param symbolDefinitions - Optional symbol definitions for type/value classification.
 * @returns Source code with import/re-export declarations added.
 */
export function addImportForMovedSymbols(
  sourceCode: string,
  movedSymbols: Set<string>,
  newModulePath: string,
  shouldReExport: boolean,
  // RATIONALE: options-object conversion deferred (part of larger split refactoring)
  // ast-grep-ignore: no-optional-param
  symbolDefinitions?: SymbolDefinition[],
): string {
  if (movedSymbols.size === 0) {
    return sourceCode;
  }

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.ts', sourceCode);

  // Classify symbols by kind (type vs value)
  const { typeSymbols, valueSymbols } = classifySymbolsByKind(
    movedSymbols,
    symbolDefinitions,
  );

  /*
    Determine which symbols need imports.
    When re-exporting, only import symbols that are actually used in the file.
  */
  const symbolsToImport = shouldReExport
    ? findReferencedSymbols(sourceFile, movedSymbols)
    : movedSymbols;

  // Filter types and values by what needs to be imported
  const typesToImport = new Set(
    [...typeSymbols].filter((s) => symbolsToImport.has(s)),
  );
  const valuesToImport = new Set(
    [...valueSymbols].filter((s) => symbolsToImport.has(s)),
  );

  // Add import declarations
  addImportDeclarations(
    sourceFile,
    typesToImport,
    valuesToImport,
    newModulePath,
  );

  // Add re-export declarations if requested
  if (shouldReExport) {
    addReExportDeclarations(
      sourceFile,
      typeSymbols,
      valueSymbols,
      newModulePath,
    );
  }

  return sourceFile.getFullText();
}
