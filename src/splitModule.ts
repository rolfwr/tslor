/**
 * Split Module Refactoring Primitives
 * 
 * This module provides the core functionality for splitting TypeScript modules
 * by extracting symbols and their dependencies into new modules.
 */

import { StaticModuleInfo } from './indexing';
import { invariant, assertDefined } from './invariant';
import { 
  Project, 
  SourceFile, 
  SyntaxKind, 
  FunctionDeclaration,
  VariableStatement,
  VariableDeclaration,
  TypeAliasDeclaration,
  InterfaceDeclaration,
  ClassDeclaration,
  JSDoc,
  ParameterDeclaration,
  PropertySignature,
  Node,
  Identifier
} from 'ts-morph';

/**
 * Represents the dependency relationships within a module
 */
export interface IntraModuleDependencies {
  exports: Set<string>;              // Exported symbols
  definitions: Set<string>;          // All defined symbols (exported + internal)
  dependencies: Map<string, Set<string>>; // symbol -> set of symbols it depends on
}

/**
 * Result of analyzing what needs to be moved when splitting a symbol
 */
export interface SplitAnalysis {
  symbolToMove: string;
  requiredDependencies: Set<string>;    // Internal symbols that must move with it
  circularDependencies: string[];       // Symbols involved in circular deps
  canSplit: boolean;                    // Whether split is possible
}

/**
 * Symbol definition extracted from source code using AST nodes
 */
export interface SymbolDefinition {
  name: string;
  kind: 'function' | 'variable' | 'type' | 'class' | 'interface' | 'const';
  node: FunctionDeclaration | VariableStatement | TypeAliasDeclaration | InterfaceDeclaration | ClassDeclaration;
  jsDocs?: JSDoc[];
  isExported: boolean;
  startPos: number;         // For debugging/verification
  endPos: number;
}

/**
 * Import usage information for symbols
 */
export interface ImportUsage {
  symbol: string;
  usesImports: Array<{
    moduleSpec: string;
    importedName: string;
    isDefault: boolean;      // Whether this is a default import
    isTypeOnly: boolean;     // Whether this is a type-only import
  }>;
}

/**
 * Required import for the new module
 */
export interface RequiredImport {
  moduleSpec: string;        // './utils' or 'lodash'
  importedNames: string[];   // ['helper', 'validator'] (empty for default imports)
  isTypeOnly: boolean;
  defaultImport?: string;    // If present, this is a default import with this local name
}

/**
 * Build a clean dependency graph from parseIsolatedSourceCode output
 */
export function buildIntraModuleDependencies(moduleInfo: StaticModuleInfo): IntraModuleDependencies {
  const exports = new Set<string>(moduleInfo.exports.keys());
  
  // Collect all symbols defined in this module:
  // 1. All symbols that use other symbols (keys of identifierUses)
  // 2. All exported symbols (from exports)
  // Note: We explicitly exclude imported symbols
  const allDefinedSymbols = new Set<string>();
  
  // Add all symbols that use other symbols (these are locally defined)
  for (const symbol of moduleInfo.identifierUses.keys()) {
    allDefinedSymbols.add(symbol);
  }
  
  // Add all exported symbols (these are locally defined)
  for (const symbol of moduleInfo.exports.keys()) {
    allDefinedSymbols.add(symbol);
  }
  
  const dependencies = new Map<string, Set<string>>();
  
  for (const [symbol, uses] of moduleInfo.identifierUses) {
    const cleanDeps = new Set<string>();
    
    for (const usedSymbol of uses) {
      cleanDeps.add(usedSymbol);
      // Only add the used symbol to our definitions if it's NOT an import
      // Check if this symbol is imported (appears in unresolvedExportsByImportNames)
      if (!moduleInfo.unresolvedExportsByImportNames.has(usedSymbol)) {
        // It's a locally defined symbol, add it
        allDefinedSymbols.add(usedSymbol);
      }
    }
    
    dependencies.set(symbol, cleanDeps);
  }
  
  // Ensure all defined symbols have dependency entries, even if they have no dependencies
  for (const symbol of allDefinedSymbols) {
    if (!dependencies.has(symbol)) {
      dependencies.set(symbol, new Set<string>());
    }
  }
  
  return {
    exports,
    definitions: allDefinedSymbols,
    dependencies
  };
}

/**
 * Compute transitive closure of dependencies for a given symbol
 */
export function computeTransitiveDependencies(deps: IntraModuleDependencies, symbol: string): Set<string> {
  const result = new Set<string>();
  const visiting = new Set<string>();
  
  function visit(sym: string): void {
    if (result.has(sym) || visiting.has(sym)) return;
    
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
export function detectCircularDependencies(deps: IntraModuleDependencies): string[][] {
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
    
    if (visited.has(symbol)) return;
    
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
export function analyzeSplit(deps: IntraModuleDependencies, targetSymbol: string): SplitAnalysis {
  if (!deps.exports.has(targetSymbol)) {
    throw new Error(`Symbol '${targetSymbol}' is not exported`);
  }
  
  const allTransitiveDeps = computeTransitiveDependencies(deps, targetSymbol);
  
  // Filter to only include dependencies that are actually defined in this module
  // (exclude imported symbols)
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
    canSplit: involvedInCycle.length === 0  // Can only split if no circular deps
  };
}

/**
 * Extract symbol definitions from TypeScript source using AST nodes
 */
export function extractSymbolDefinitions(sourceFile: SourceFile, symbolNames: Set<string>): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = [];
  
  // Find function declarations
  sourceFile.getFunctions().forEach(func => {
    const name = func.getName();
    if (name && symbolNames.has(name)) {
      definitions.push({
        name,
        kind: 'function',
        node: func,
        jsDocs: func.getJsDocs().length > 0 ? func.getJsDocs() : undefined,
        isExported: func.isExported(),
        startPos: func.getStart(),
        endPos: func.getEnd()
      });
    }
  });
  
  // Find variable declarations (const, let, var)
  sourceFile.getVariableStatements().forEach(stmt => {
    stmt.getDeclarations().forEach(decl => {
      const name = decl.getName();
      if (symbolNames.has(name)) {
        definitions.push({
          name,
          kind: stmt.getDeclarationKind() === 'const' ? 'const' : 'variable',
          node: stmt,
          jsDocs: stmt.getJsDocs().length > 0 ? stmt.getJsDocs() : undefined,
          isExported: stmt.isExported(),
          startPos: stmt.getStart(),
          endPos: stmt.getEnd()
        });
      }
    });
  });
  
  // Find type aliases
  sourceFile.getTypeAliases().forEach(type => {
    const name = type.getName();
    if (symbolNames.has(name)) {
      definitions.push({
        name,
        kind: 'type',
        node: type,
        jsDocs: type.getJsDocs().length > 0 ? type.getJsDocs() : undefined,
        isExported: type.isExported(),
        startPos: type.getStart(),
        endPos: type.getEnd()
      });
    }
  });
  
  // Find interfaces
  sourceFile.getInterfaces().forEach(iface => {
    const name = iface.getName();
    if (symbolNames.has(name)) {
      definitions.push({
        name,
        kind: 'interface',
        node: iface,
        jsDocs: iface.getJsDocs().length > 0 ? iface.getJsDocs() : undefined,
        isExported: iface.isExported(),
        startPos: iface.getStart(),
        endPos: iface.getEnd()
      });
    }
  });
  
  // Find classes
  sourceFile.getClasses().forEach(cls => {
    const name = cls.getName();
    if (name && symbolNames.has(name)) {
      definitions.push({
        name,
        kind: 'class',
        node: cls,
        jsDocs: cls.getJsDocs().length > 0 ? cls.getJsDocs() : undefined,
        isExported: cls.isExported(),
        startPos: cls.getStart(),
        endPos: cls.getEnd()
      });
    }
  });
  
  return definitions;
}

/**
 * Analyze which imports are used by which symbols
 */
export function analyzeImportUsageBySymbol(sourceFile: SourceFile): ImportUsage[] {
  const result: ImportUsage[] = [];
  const importMap = new Map<string, {
    moduleSpec: string;
    isDefault: boolean;
    isTypeOnly: boolean;
  }>(); // imported name -> import details
  
  // Build map of imports (both named and default)
  sourceFile.getImportDeclarations().forEach(importDecl => {
    const moduleSpec = importDecl.getModuleSpecifierValue();
    const isTypeOnly = importDecl.isTypeOnly();
    
    // Handle default imports
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
      const importedName = defaultImport.getText();
      importMap.set(importedName, {
        moduleSpec,
        isDefault: true,
        isTypeOnly
      });
    }
    
    // Handle named imports
    importDecl.getNamedImports().forEach(namedImport => {
      const importedName = namedImport.getName();
      importMap.set(importedName, {
        moduleSpec,
        isDefault: false,
        isTypeOnly: isTypeOnly || namedImport.isTypeOnly()
      });
    });
  });
  
  // Find all symbols (functions, variables, interfaces, types, classes, etc.)
  const allSymbols = new Map<string, Node>();
  
  sourceFile.getFunctions().forEach(func => {
    const name = func.getName();
    if (name) allSymbols.set(name, func);
  });
  
  sourceFile.getVariableStatements().forEach(stmt => {
    stmt.getDeclarations().forEach(decl => {
      allSymbols.set(decl.getName(), decl);
    });
  });
  
  sourceFile.getInterfaces().forEach(iface => {
    allSymbols.set(iface.getName(), iface);
  });
  
  sourceFile.getTypeAliases().forEach(typeAlias => {
    allSymbols.set(typeAlias.getName(), typeAlias);
  });
  
  sourceFile.getClasses().forEach(cls => {
    const name = cls.getName();
    if (name) allSymbols.set(name, cls);
  });
  
  // For each symbol, find what imports it uses
  for (const [symbolName, symbolNode] of allSymbols.entries()) {
    const usesImports: Array<{
      moduleSpec: string;
      importedName: string;
      isDefault: boolean;
      isTypeOnly: boolean;
    }> = [];
    
    // Find all identifiers in this symbol's node
    symbolNode.getDescendantsOfKind(SyntaxKind.Identifier).forEach(identifier => {
      const idName = identifier.getText();
      if (importMap.has(idName)) {
        const importInfo = importMap.get(idName);
        assertDefined(importInfo, `Import info should be defined for ${idName}`);
        usesImports.push({
          moduleSpec: importInfo.moduleSpec,
          importedName: idName,
          isDefault: importInfo.isDefault,
          isTypeOnly: importInfo.isTypeOnly
        });
      }
    });
    
    // Remove duplicates
    const uniqueImports = Array.from(new Map(
      usesImports.map(imp => [`${imp.moduleSpec}:${imp.importedName}:${imp.isDefault}`, imp])
    ).values());
    
    result.push({
      symbol: symbolName,
      usesImports: uniqueImports
    });
  }
  
  return result;
}

/**
 * Find imports that are only used by specific symbols
 */
export function findImportsOnlyUsedBySymbols(
  importUsages: ImportUsage[], 
  targetSymbols: Set<string>
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
 * Adjust a module specifier from source file's perspective to target file's perspective
 */
function adjustModuleSpecForNewLocation(
  moduleSpec: string,
  sourceFilePath: string,
  targetFilePath: string
): string {
  // Only adjust relative imports (starting with ./ or ../)
  if (!moduleSpec.startsWith('.')) {
    return moduleSpec;
  }
  
  const path = require('path');
  
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
export function computeRequiredImports(
  symbolDefinitions: SymbolDefinition[],
  importUsages: ImportUsage[],
  onlyUsedByTarget: Set<string>,
  sourceFilePath?: string,
  targetFilePath?: string
): RequiredImport[] {
  const requiredImportsMap = new Map<string, {
    namedImports: Set<string>;
    defaultImport?: string;
    isTypeOnly: boolean;
  }>();
  
  // Find which imports the moved symbols need
  const movedSymbolNames = new Set(symbolDefinitions.map(def => def.name));
  
  for (const usage of importUsages) {
    if (movedSymbolNames.has(usage.symbol)) {
      for (const imp of usage.usesImports) {
        const importKey = `${imp.moduleSpec}:${imp.importedName}`;
        
        // Only include imports that are exclusively used by target symbols
        // or imports that are shared but needed by the moved symbols
        if (onlyUsedByTarget.has(importKey) || 
            usage.usesImports.some(() => movedSymbolNames.has(usage.symbol))) {
          
          if (!requiredImportsMap.has(imp.moduleSpec)) {
            requiredImportsMap.set(imp.moduleSpec, {
              namedImports: new Set(),
              isTypeOnly: imp.isTypeOnly
            });
          }
          
          const entry = requiredImportsMap.get(imp.moduleSpec)!;
          
          if (imp.isDefault) {
            entry.defaultImport = imp.importedName;
          } else {
            entry.namedImports.add(imp.importedName);
          }
          
          // Update isTypeOnly - it should be true only if ALL imports from this module are type-only
          if (!imp.isTypeOnly) {
            entry.isTypeOnly = false;
          }
        }
      }
    }
  }
  
  // Convert to RequiredImport array and adjust paths if file locations provided
  return Array.from(requiredImportsMap.entries()).map(([moduleSpec, info]) => {
    // Adjust relative paths if we have source and target file paths
    const adjustedModuleSpec = (sourceFilePath && targetFilePath)
      ? adjustModuleSpecForNewLocation(moduleSpec, sourceFilePath, targetFilePath)
      : moduleSpec;
    
    return {
      moduleSpec: adjustedModuleSpec,
      importedNames: Array.from(info.namedImports).sort(),
      isTypeOnly: info.isTypeOnly,
      defaultImport: info.defaultImport
    };
  });
}

/**
 * Generate the source code for a new module.
 * 
 * Uses node.getFullText() to preserve all aspects of symbols including:
 * - All members (properties, methods, etc.)
 * - Comments and JSDoc
 * - Formatting
 */
/**
 * If the statement declares a symbol matching `exportNames`, export it.
 */
function exportStatementIfNeeded(stmt: Node, exportNames: Set<string>): void {
  if (Node.isVariableStatement(stmt)) {
    const name = stmt.getDeclarations()[0]?.getName();
    if (name && exportNames.has(name)) stmt.setIsExported(true);
  } else if (Node.isFunctionDeclaration(stmt) || Node.isClassDeclaration(stmt)) {
    const name = stmt.getName();
    if (name && exportNames.has(name)) stmt.setIsExported(true);
  } else if (Node.isTypeAliasDeclaration(stmt) || Node.isInterfaceDeclaration(stmt)) {
    const name = stmt.getName();
    if (exportNames.has(name)) stmt.setIsExported(true);
  }
}

export function generateNewModuleSource(
  symbolDefinitions: SymbolDefinition[],
  requiredImports: RequiredImport[],
  additionalExports?: Set<string>
): string {
  // Create a new source file using ts-morph
  const project = new Project({ useInMemoryFileSystem: true });
  const newFile = project.createSourceFile('new-module.ts', '');
  
  // Add imports using AST methods
  for (const imp of requiredImports) {
    // Handle default imports separately from named imports
    // If there's both a default and named imports, we need two separate import declarations
    if (imp.defaultImport && imp.importedNames.length > 0) {
      // Add default import
      const defaultStructure: any = {
        moduleSpecifier: imp.moduleSpec,
        defaultImport: imp.defaultImport
      };
      if (imp.isTypeOnly) {
        defaultStructure.isTypeOnly = true;
      }
      newFile.addImportDeclaration(defaultStructure);
      
      // Add named imports
      const namedStructure: any = {
        moduleSpecifier: imp.moduleSpec,
        namedImports: imp.importedNames
      };
      if (imp.isTypeOnly) {
        namedStructure.isTypeOnly = true;
      }
      newFile.addImportDeclaration(namedStructure);
    } else if (imp.defaultImport) {
      // Just default import
      const importStructure: any = {
        moduleSpecifier: imp.moduleSpec,
        defaultImport: imp.defaultImport
      };
      if (imp.isTypeOnly) {
        importStructure.isTypeOnly = true;
      }
      newFile.addImportDeclaration(importStructure);
    } else if (imp.importedNames.length > 0) {
      // Just named imports
      const importStructure: any = {
        moduleSpecifier: imp.moduleSpec,
        namedImports: imp.importedNames
      };
      if (imp.isTypeOnly) {
        importStructure.isTypeOnly = true;
      }
      newFile.addImportDeclaration(importStructure);
    }
  }
  
  // Add symbol definitions by inserting their full AST text
  // This preserves everything: methods, properties, comments, JSDoc, formatting, etc.
  const sortedDefinitions = symbolDefinitions.sort((a, b) => a.startPos - b.startPos);
  
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
 * Remove symbol definitions from the original source file
 */
export function removeSymbolsFromSource(
  sourceFile: SourceFile, 
  symbolsToRemove: Set<string>
): string {
  // Create a mutable copy of the source file
  const timestamp = Date.now() + Math.random();
  const modifiedSourceFile = sourceFile.copy(`modified-${timestamp}.ts`);
  
  // Use replaceWithText('') instead of remove() to preserve leading trivia
  // (blank lines between declarations). remove() eats leading trivia;
  // replaceWithText('') replaces from getStart(true) to getEnd(), keeping
  // the whitespace that separated this node from the previous one.

  // Remove function declarations
  modifiedSourceFile.getFunctions().forEach(func => {
    const name = func.getName();
    if (name && symbolsToRemove.has(name)) {
      func.replaceWithText('');
    }
  });

  // Remove variable statements
  modifiedSourceFile.getVariableStatements().forEach(stmt => {
    const declarations = stmt.getDeclarations();
    const declarationsToKeep = declarations.filter(decl => !symbolsToRemove.has(decl.getName()));

    if (declarationsToKeep.length === 0) {
      // Remove entire statement if all declarations are being removed
      stmt.replaceWithText('');
    } else if (declarationsToKeep.length < declarations.length) {
      // Some declarations removed - reconstruct using AST methods
      const kind = stmt.getDeclarationKind();
      const isExported = stmt.isExported();

      // Create new variable statement with only the kept declarations
      const newDeclarations = declarationsToKeep.map(decl => ({
        name: decl.getName(),
        type: decl.getTypeNode()?.getText(),
        initializer: decl.getInitializer()?.getText()
      }));

      // Replace the statement using ts-morph methods
      stmt.replaceWithText(
        modifiedSourceFile.addVariableStatement({
          declarationKind: kind,
          isExported,
          declarations: newDeclarations
        }).getFullText()
      );
    }
  });

  // Remove type aliases
  modifiedSourceFile.getTypeAliases().forEach(type => {
    const name = type.getName();
    if (symbolsToRemove.has(name)) {
      type.replaceWithText('');
    }
  });

  // Remove interfaces
  modifiedSourceFile.getInterfaces().forEach(iface => {
    const name = iface.getName();
    if (symbolsToRemove.has(name)) {
      iface.replaceWithText('');
    }
  });

  // Remove classes
  modifiedSourceFile.getClasses().forEach(cls => {
    const name = cls.getName();
    if (name && symbolsToRemove.has(name)) {
      cls.replaceWithText('');
    }
  });

  // Collapse extra blank lines left by replaceWithText('') to single blank lines
  let result = modifiedSourceFile.getFullText();
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

/**
 * Remove unused imports from the source file
 */
export function removeUnusedImports(
  sourceFile: SourceFile,
  _removedSymbols: Set<string>,
  onlyUsedByRemovedSymbols: Set<string>
): string {
  // Create a mutable copy with unique name
  const timestamp = Date.now() + Math.random();
  const modifiedSourceFile = sourceFile.copy(`modified-${timestamp}.ts`);
  
  // Remove import declarations that are only used by removed symbols
  modifiedSourceFile.getImportDeclarations().forEach(importDecl => {
    const moduleSpec = importDecl.getModuleSpecifierValue();
    
    // Check default import
    const defaultImport = importDecl.getDefaultImport();
    const defaultImportText = defaultImport?.getText();
    const shouldRemoveDefault = defaultImport && 
      onlyUsedByRemovedSymbols.has(`${moduleSpec}:${defaultImportText}`);
    
    // Check namespace import
    const namespaceImport = importDecl.getNamespaceImport();
    const shouldRemoveNamespace = namespaceImport &&
      onlyUsedByRemovedSymbols.has(`${moduleSpec}:${namespaceImport.getText()}`);
    
    // Check named imports
    const namedImports = importDecl.getNamedImports();
    const importsToKeep = namedImports.filter(namedImport => {
      const importName = namedImport.getName();
      const importKey = `${moduleSpec}:${importName}`;
      return !onlyUsedByRemovedSymbols.has(importKey);
    });
    
    // Determine if entire import should be removed
    const hasNoNamedImports = namedImports.length === 0;
    const hasNoKeptNamedImports = importsToKeep.length === 0;
    const shouldRemoveEntireImport = 
      (hasNoNamedImports && (shouldRemoveDefault || shouldRemoveNamespace)) ||
      (!hasNoNamedImports && hasNoKeptNamedImports && !defaultImport && !namespaceImport);
    
    if (shouldRemoveEntireImport) {
      // Remove entire import declaration
      importDecl.remove();
    } else if (importsToKeep.length < namedImports.length) {
      // Some named imports removed - reconstruct the import
      const keptImportNames = importsToKeep.map(imp => imp.getName()).join(', ');
      const newImportText = `import { ${keptImportNames} } from '${moduleSpec}';`;
      importDecl.replaceWithText(newImportText);
    }
  });
  
  return modifiedSourceFile.getFullText();
}

/**
 * Add import and re-export for moved symbols (for backward compatibility)
 */
/**
 * Classify symbols into types and values based on their definitions
 */
function classifySymbolsByKind(
  symbols: Set<string>,
  symbolDefinitions?: SymbolDefinition[]
): { typeSymbols: Set<string>; valueSymbols: Set<string> } {
  const typeSymbols = new Set<string>();
  const valueSymbols = new Set<string>();
  
  if (symbolDefinitions) {
    const defMap = new Map(symbolDefinitions.map(d => [d.name, d]));
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
    symbols.forEach(s => valueSymbols.add(s));
  }
  
  return { typeSymbols, valueSymbols };
}

/**
 * Find which symbols are actually referenced in the source file
 */
function findReferencedSymbols(
  sourceFile: SourceFile,
  candidateSymbols: Set<string>
): Set<string> {
  const referencedSymbols = new Set<string>();
  
  sourceFile.forEachDescendant(node => {
    if (node.getKind() === SyntaxKind.Identifier) {
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
  modulePath: string
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
  modulePath: string
): void {
  if (typeSymbols.size > 0) {
    sourceFile.addExportDeclaration({
      moduleSpecifier: modulePath,
      namedExports: Array.from(typeSymbols).sort(),
      isTypeOnly: true
    });
  }
  
  if (valueSymbols.size > 0) {
    sourceFile.addExportDeclaration({
      moduleSpecifier: modulePath,
      namedExports: Array.from(valueSymbols).sort()
    });
  }
}

export function addImportForMovedSymbols(
  sourceFile: SourceFile,
  movedSymbols: Set<string>,
  newModulePath: string,
  shouldReExport: boolean,
  symbolDefinitions?: SymbolDefinition[]
): string {
  const timestamp = Date.now() + Math.random();
  const modifiedSourceFile = sourceFile.copy(`modified-${timestamp}.ts`);
  
  if (movedSymbols.size === 0) {
    return modifiedSourceFile.getFullText();
  }
  
  // Classify symbols by kind (type vs value)
  const { typeSymbols, valueSymbols } = classifySymbolsByKind(movedSymbols, symbolDefinitions);
  
  // Determine which symbols need imports
  // When re-exporting, only import symbols that are actually used in the file
  const symbolsToImport = shouldReExport
    ? findReferencedSymbols(sourceFile, movedSymbols)
    : movedSymbols;
  
  // Filter types and values by what needs to be imported
  const typesToImport = new Set([...typeSymbols].filter(s => symbolsToImport.has(s)));
  const valuesToImport = new Set([...valueSymbols].filter(s => symbolsToImport.has(s)));
  
  // Add import declarations
  addImportDeclarations(modifiedSourceFile, typesToImport, valuesToImport, newModulePath);
  
  // Add re-export declarations if requested
  if (shouldReExport) {
    addReExportDeclarations(modifiedSourceFile, typeSymbols, valueSymbols, newModulePath);
  }
  
  return modifiedSourceFile.getFullText();
}