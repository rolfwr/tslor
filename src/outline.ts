#!/usr/bin/env tsx

/**
 * TypeScript Module Outline Utility
 * 
 * Enumerates top-level members of TypeScript modules with line numbers.
 * Useful for Claude Code to quickly understand file structure.
 * 
 * Usage: pnpm run outline <MODULE_PATH_TS>
 */

import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { TransformingFileSystem } from './transformingFileSystem.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

interface MemberInfo {
  line: number;
  endLine: number;
  type: string;
  name: string;
  exported: boolean;
  signature?: string;
}

/**
 * Get line number from position in source file
 */
function getLineNumber(sourceFile: SourceFile, pos: number): number {
  return sourceFile.getLineAndColumnAtPos(pos).line;
}

/**
 * Extract function signature for display
 */
function getFunctionSignature(func: any): string {
  const name = func.getName() || '<anonymous>';
  const params = func.getParameters().map((p: any) => {
    const paramName = p.getName();
    const paramType = p.getTypeNode()?.getText() || '';
    const optional = p.hasQuestionToken() ? '?' : '';
    return paramType ? `${paramName}${optional}: ${paramType}` : paramName;
  }).join(', ');
  
  const returnType = func.getReturnTypeNode()?.getText();
  const returnPart = returnType ? `: ${returnType}` : '';
  
  return `${name}(${params})${returnPart}`;
}

/**
 * Extract variable/constant signature for display
 */
function getVariableSignature(stmt: any): string {
  const kind = stmt.getDeclarationKind(); // const, let, var
  const declarations = stmt.getDeclarations();
  
  if (declarations.length === 1) {
    const decl = declarations[0];
    const name = decl.getName();
    const type = decl.getTypeNode()?.getText();
    const typePart = type ? `: ${type}` : '';
    return `${kind} ${name}${typePart}`;
  } else {
    const names = declarations.map((d: any) => d.getName()).join(', ');
    return `${kind} ${names}`;
  }
}

/**
 * Extract type alias signature for display
 */
function getTypeAliasSignature(typeAlias: any): string {
  const name = typeAlias.getName();
  const typeNode = typeAlias.getTypeNode()?.getText() || '';
  return `type ${name} = ${typeNode}`;
}

/**
 * Extract interface signature for display
 */
function getInterfaceSignature(iface: any): string {
  const name = iface.getName();
  const props = iface.getProperties();
  const propCount = props.length;
  const heritage = iface.getHeritageClauses();
  const extendsClause = heritage.length > 0 ? ` extends ${heritage[0].getTypeNodes().map((n: any) => n.getText()).join(', ')}` : '';
  
  return `interface ${name}${extendsClause} { ${propCount} properties }`;
}

/**
 * Extract class signature for display
 */
function getClassSignature(cls: any): string {
  const name = cls.getName() || '<anonymous>';
  const heritage = cls.getHeritageClauses();
  const extendsClause = heritage.find((h: any) => h.getToken() === SyntaxKind.ExtendsKeyword);
  const implementsClause = heritage.find((h: any) => h.getToken() === SyntaxKind.ImplementsKeyword);
  
  let signature = `class ${name}`;
  if (extendsClause) {
    signature += ` extends ${extendsClause.getTypeNodes().map((n: any) => n.getText()).join(', ')}`;
  }
  if (implementsClause) {
    signature += ` implements ${implementsClause.getTypeNodes().map((n: any) => n.getText()).join(', ')}`;
  }
  
  const methods = cls.getMethods().length;
  const properties = cls.getProperties().length;
  signature += ` { ${methods} methods, ${properties} properties }`;
  
  return signature;
}

/**
 * Extract import/export signature for display
 */
function getImportSignature(importDecl: any): string {
  const moduleSpec = importDecl.getModuleSpecifierValue();
  const namedImports = importDecl.getNamedImports();
  const defaultImport = importDecl.getDefaultImport();
  const namespaceImport = importDecl.getNamespaceImport();
  
  let signature = 'import ';
  
  if (defaultImport) {
    signature += defaultImport.getName();
    if (namedImports.length > 0 || namespaceImport) signature += ', ';
  }
  
  if (namespaceImport) {
    signature += `* as ${namespaceImport.getName()}`;
    if (namedImports.length > 0) signature += ', ';
  }
  
  if (namedImports.length > 0) {
    if (namedImports.length <= 3) {
      const names = namedImports.map((imp: any) => imp.getName()).join(', ');
      signature += `{ ${names} }`;
    } else {
      signature += `{ ${namedImports[0].getName()}, ... +${namedImports.length - 1} more }`;
    }
  }
  
  signature += ` from '${moduleSpec}'`;
  return signature;
}

function getExportSignature(exportDecl: any): string {
  const moduleSpec = exportDecl.getModuleSpecifier()?.getLiteralValue();
  const namedExports = exportDecl.getNamedExports();
  
  let signature = 'export ';
  
  if (namedExports.length > 0) {
    if (namedExports.length <= 3) {
      const names = namedExports.map((exp: any) => exp.getName()).join(', ');
      signature += `{ ${names} }`;
    } else {
      signature += `{ ${namedExports[0].getName()}, ... +${namedExports.length - 1} more }`;
    }
  }
  
  if (moduleSpec) {
    signature += ` from '${moduleSpec}'`;
  }
  
  return signature;
}

/**
 * Analyze a TypeScript source file and extract member information
 */
function analyzeSourceFile(sourceFile: SourceFile): MemberInfo[] {
  const members: MemberInfo[] = [];
  
  // Import declarations
  sourceFile.getImportDeclarations().forEach(importDecl => {
    members.push({
      line: getLineNumber(sourceFile, importDecl.getStart()),
      endLine: getLineNumber(sourceFile, importDecl.getEnd()),
      type: 'import',
      name: getImportSignature(importDecl),
      exported: false,
      signature: getImportSignature(importDecl)
    });
  });
  
  // Function declarations
  sourceFile.getFunctions().forEach(func => {
    const name = func.getName() || '<anonymous>';
    members.push({
      line: getLineNumber(sourceFile, func.getStart()),
      endLine: getLineNumber(sourceFile, func.getEnd()),
      type: 'function',
      name,
      exported: func.isExported(),
      signature: getFunctionSignature(func)
    });
  });
  
  // Variable statements (const, let, var)
  sourceFile.getVariableStatements().forEach(stmt => {
    const declarations = stmt.getDeclarations();
    const name = declarations.length === 1 ? declarations[0].getName() : 
                 declarations.map(d => d.getName()).join(', ');
    
    members.push({
      line: getLineNumber(sourceFile, stmt.getStart()),
      endLine: getLineNumber(sourceFile, stmt.getEnd()),
      type: 'variable',
      name,
      exported: stmt.isExported(),
      signature: getVariableSignature(stmt)
    });
  });
  
  // Type aliases
  sourceFile.getTypeAliases().forEach(typeAlias => {
    const name = typeAlias.getName();
    members.push({
      line: getLineNumber(sourceFile, typeAlias.getStart()),
      endLine: getLineNumber(sourceFile, typeAlias.getEnd()),
      type: 'type',
      name,
      exported: typeAlias.isExported(),
      signature: getTypeAliasSignature(typeAlias)
    });
  });
  
  // Interfaces
  sourceFile.getInterfaces().forEach(iface => {
    const name = iface.getName();
    members.push({
      line: getLineNumber(sourceFile, iface.getStart()),
      endLine: getLineNumber(sourceFile, iface.getEnd()),
      type: 'interface',
      name,
      exported: iface.isExported(),
      signature: getInterfaceSignature(iface)
    });
  });
  
  // Classes
  sourceFile.getClasses().forEach(cls => {
    const name = cls.getName() || '<anonymous>';
    members.push({
      line: getLineNumber(sourceFile, cls.getStart()),
      endLine: getLineNumber(sourceFile, cls.getEnd()),
      type: 'class',
      name,
      exported: cls.isExported(),
      signature: getClassSignature(cls)
    });
  });
  
  // Export declarations
  sourceFile.getExportDeclarations().forEach(exportDecl => {
    members.push({
      line: getLineNumber(sourceFile, exportDecl.getStart()),
      endLine: getLineNumber(sourceFile, exportDecl.getEnd()),
      type: 'export',
      name: getExportSignature(exportDecl),
      exported: true,
      signature: getExportSignature(exportDecl)
    });
  });
  
  // Sort by line number
  return members.sort((a, b) => a.line - b.line);
}

/**
 * Format member information for display
 */
function formatMember(member: MemberInfo, verbose: boolean = false): string {
  const lineRange = member.line === member.endLine ? 
    `${member.line}` : 
    `${member.line}-${member.endLine}`;
  
  const exportPrefix = member.exported ? 'export ' : '';
  
  // Special handling for imports and exports to avoid repetition
  if (member.type === 'import' || member.type === 'export') {
    return `${lineRange} ${member.name}`;
  }
  
  if (verbose) {
    const signature = member.signature ?? member.name;
    return `${lineRange} ${exportPrefix}${member.type} ${signature}`;
  } else {
    // Minimal format: line type name
    return `${lineRange} ${exportPrefix}${member.type} ${member.name}`;
  }
}

/**
 * Main outline function
 */
async function outline(filePath: string, options: { verbose?: boolean; quiet?: boolean; includeImports?: boolean } = {}): Promise<void> {
  const absolutePath = resolve(filePath);
  
  if (!existsSync(absolutePath)) {
    if (!options.quiet) console.error(`File not found: ${absolutePath}`);
    process.exit(1);
  }
  
  try {
    // Create project with minimal configuration for outline purposes
    const project = new Project({ 
      useInMemoryFileSystem: false,
      fileSystem: new TransformingFileSystem(),
      // Skip TypeScript compiler options to avoid dependency issues
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        declaration: false
      }
    });
    const sourceFile = project.addSourceFileAtPath(absolutePath);
    
    const members = analyzeSourceFile(sourceFile);
    
    if (members.length === 0) {
      if (!options.quiet) console.log('(no members)');
      return;
    }
    
    if (options.verbose) {
      // Verbose mode: include summary and signatures
      const byType = members.reduce((acc, member) => {
        acc[member.type] = (acc[member.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      console.log(`# ${filePath}`);
      const summary = Object.entries(byType).map(([type, count]) => count + ' ' + type).join(', ');
      console.log(`Summary: ${summary}`);
      console.log('');
    }
    
    // Filter out imports unless explicitly requested
    const filteredMembers = options.includeImports ? 
      members : 
      members.filter(member => member.type !== 'import');
    
    // Output members in minimal format
    filteredMembers.forEach(member => {
      console.log(formatMember(member, options.verbose));
    });
    
  } catch (error) {
    if (!options.quiet) console.error(`Error: ${error}`);
    process.exit(1);
  }
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  let filePath = '';
  let verbose = false;
  let quiet = false;
  let includeImports = false;
  
  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-v' || arg === '--verbose') {
      verbose = true;
    } else if (arg === '-q' || arg === '--quiet') {
      quiet = true;
    } else if (arg === '-i' || arg === '--include-imports') {
      includeImports = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: tsx src/outline.ts [options] <file>');
      console.log('');
      console.log('Options:');
      console.log('  -v, --verbose         Include signatures and summary');
      console.log('  -q, --quiet           Suppress error messages');
      console.log('  -i, --include-imports Include import statements (omitted by default)');
      console.log('  -h, --help            Show this help');
      console.log('');
      console.log('Examples:');
      console.log('  tsx src/outline.ts src/splitModule.ts');
      console.log('  tsx src/outline.ts -v src/indexing.ts');
      console.log('  pnpm run outline src/components/MyComponent.vue');
      process.exit(0);
    } else if (!filePath && !arg.startsWith('-')) {
      filePath = arg;
    }
  }
  
  if (!filePath) {
    if (!quiet) {
      console.error('Usage: tsx src/outline.ts [options] <file>');
      console.error('Use -h for help');
    }
    process.exit(1);
  }
  
  outline(filePath, { verbose, quiet, includeImports }).catch(error => {
    if (!quiet) console.error('Error:', error);
    process.exit(1);
  });
}

export { outline, analyzeSourceFile, MemberInfo };