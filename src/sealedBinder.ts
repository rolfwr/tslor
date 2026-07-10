/**
 * Sealed single-file binder project.
 *
 * Creates a one-file in-memory TypeScript project and extracts the module-scope
 * binding set from the binder via getLocals(). The in-memory filesystem
 * denies all filesystem probes, guaranteeing no cross-module pull-in.
 */

import {
  BindingName,
  Node,
  Project,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';

/**
 * Create a source file inside a sealed in-memory project.
 *
 * The in-memory filesystem denies all filesystem probes, and
 * `skipLoadingLibFiles` is set so binder calls do not parse lib.d.ts.
 * This guarantees no cross-module pull-in when binder APIs are used.
 *
 * @param sourceText - Source text for the file
 * @param opts.filePath - Optional file path (defaults to `'module.ts'`)
 * @returns SourceFile inside a sealed single-file project
 */
function createSealedSourceFile(
  sourceText: string,
  opts: { filePath?: string },
): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipLoadingLibFiles: true,
  });
  return project.createSourceFile(
    opts.filePath ?? 'module.ts',
    sourceText,
  );
}

/**
 * Get the set of module-scope bindings in the source text.
 *
 * Parses the text in a sealed in-memory project and returns the
 * binding names from `getLocals()`. This includes all import forms,
 * declarations (var/let/const, function, class, interface, etc.),
 * and hoisted `var` from top-level blocks. Inner-scope bindings
 * (function parameters, inner locals) are excluded.
 *
 * @param sourceText - Source text to analyze
 * @param opts.filePath - Optional file path (defaults to `'module.ts'`)
 * @returns Set of module-scope binding names
 */
export function getModuleBindingSet(
  sourceText: string,
  opts: { filePath?: string },
): Set<string> {
  const sourceFile = createSealedSourceFile(sourceText, opts);
  return new Set(sourceFile.getLocals().map(function (sym) { return sym.getName(); }));
}

/**
 * Collect all declared names across all scopes.
 *
 * Uses getLocals() for module-scope bindings and walks the AST for inner-scope
 * bindings (parameters, type parameters, variable declarations including
 * destructuring). This avoids the type checker — only the binder is used.
 *
 * @param sourceFile - Sealed SourceFile to analyze
 * @returns Set of all declared names across all scopes
 */
export function collectAllDeclaredNames(
  sourceFile: SourceFile,
): Set<string> {
  const sf = sourceFile;

  const declared = new Set(
    sf.getLocals().map(function (sym) { return sym.getName(); }),
  );

  for (const param of sf.getDescendantsOfKind(SyntaxKind.Parameter)) {
    addBindingName(param.getNameNode(), declared);
  }

  for (const tp of sf.getDescendantsOfKind(SyntaxKind.TypeParameter)) {
    declared.add(tp.getName());
  }

  for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    addBindingName(vd.getNameNode(), declared);
  }

  return declared;
}

/**
 * Recursively collect binding names from a BindingName node.
 * Handles identifiers and destructuring patterns (ObjectBindingPattern /
 * ArrayBindingPattern) with nested BindingElements.
 */
export function addBindingName(name: BindingName, names: Set<string>): void {
  if (Node.isIdentifier(name)) {
    names.add(name.getText());
  } else {
    for (const element of name.getElements()) {
      if (Node.isBindingElement(element)) {
        addBindingName(element.getNameNode(), names);
      }
    }
  }
}

/**
 * Scope-aware ambient classification for candidate names.
 *
 * Given source text and a list of candidate ambient names, determines which
 * are truly ambient by checking that no declaration of the same name exists
 * in the file at any scope level. This prunes over-approximation false
 * positives such as leaked function-local names from the index.
 *
 * @param sourceText - Source text to analyze
 * @param candidateNames - Names to verify (from over-approximation tier)
 * @param opts.filePath - Optional file path (defaults to `'module.ts'`)
 * @returns Set of names that are truly ambient
 */
export function filterTrulyAmbientNames(
  sourceText: string,
  candidateNames: readonly string[],
  opts: { filePath?: string },
): Set<string> {
  const declaredNames = collectAllDeclaredNames(createSealedSourceFile(sourceText, opts));
  return new Set(candidateNames.filter(function (name) { return !declaredNames.has(name); }));
}
