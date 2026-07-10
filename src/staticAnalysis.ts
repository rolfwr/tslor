/**
 * Static AST analysis for TypeScript modules.
 *
 * Parses source files into StaticModuleInfo without any filesystem access
 * beyond the initial file read. Used by both the indexing pipeline and
 * tools that need module-level import/export analysis.
 */

import {
  ArrayTypeNode,
  ArrowFunction,
  CallSignatureDeclaration,
  ClassDeclaration,
  ClassExpression,
  ConditionalTypeNode,
  ConstructorTypeNode,
  ConstructSignatureDeclaration,
  EnumDeclaration,
  ExportAssignment,
  ExportDeclaration,
  ExpressionWithTypeArguments,
  FunctionDeclaration,
  FunctionExpression,
  FunctionTypeNode,
  GetAccessorDeclaration,
  IndexedAccessTypeNode,
  IndexSignatureDeclaration,
  ImportDeclaration,
  ImportSpecifier,
  ImportTypeNode,
  InterfaceDeclaration,
  MappedTypeNode,
  Node,
  ParenthesizedTypeNode,
  RestTypeNode,
  SetAccessorDeclaration,
  SourceFile,
  SyntaxKind,
  TemplateLiteralTypeNode,
  TupleTypeNode,
  TypeAliasDeclaration,
  TypeLiteralNode,
  TypeParameterDeclaration,
  TypeReferenceNode,
  TypeNode,
  TypeOperatorTypeNode,
  TypeQueryNode,
  VariableDeclaration,
  VariableStatement,
} from 'ts-morph';
import { addBindingName, collectAllDeclaredNames } from './sealedBinder';


export interface StaticModuleInfo {
  imports: UnresolvedImports[];
  unresolvedExportsByImportNames: Map<string, UnresolvedExport>;
  identifierUses: Map<string, string[]>;
  exportedNames: Set<string>;
  reExports: ReExport[];
  /**
   * Ambient runtime-position names referenced in this module.
   *
   * Walks every identifier, filters out binding/property/type-only positions,
   * then subtracts locally-bound names. Includes function-scoped bindings so
   * function-locals are excluded — only truly unbound names remain.
   * Type-only ambient references are excluded — they are tracked via
   * `identifierUses` instead. The exact tier (sealed binder) further prunes
   * false positives at report time.
   */
  ambientNames: Set<string>;
}


/**
 * Import usage entry for a single symbol.
 *
 * Maps a symbol name to the deduplicated set of imports it references.
 */
export interface ImportUsage {
  symbol: string;
  usesImports: UseImport[];
}


interface UnresolvedImports {
  moduleSpec: string;
  names: string[];
  typeOnly: boolean;
}


interface UnresolvedExport {
  name: string;
  moduleSpec: string;
  isTypeOnly: boolean;
}


/**
 * Re-export entry from static analysis.
 *
 * `name` is the exported name (or `'*'` for star re-exports).
 * `moduleSpec` is the original module specifier string.
 * `resolvedPath` is populated by downstream resolution layers (e.g. inspectModule).
 */
export interface ReExport {
  name: string;
  moduleSpec: string;
  resolvedPath?: string;
  isTypeOnly: boolean;
}


function addIdentifierUses(
  staticModuleInfo: StaticModuleInfo,
  symbolName: string,
  uses: string[],
): void {
  let usedIds = staticModuleInfo.identifierUses.get(symbolName);
  if (!usedIds) {
    usedIds = [];
    staticModuleInfo.identifierUses.set(symbolName, usedIds);
  }
  usedIds.push(...uses);
}


type TypeRefCallback = (name: string) => void;


function traverseTypeReferenceNode(
  typeNode: TypeReferenceNode,
  fn: TypeRefCallback,
): void {
  const typeName = typeNode.getTypeName();
  if (typeName.isKind(SyntaxKind.Identifier)) {
    fn(typeName.getText());
  }
  for (const typeArg of typeNode.getTypeArguments()) {
    traverseTypeNodeWith(typeArg, fn);
  }
}


function traverseExpressionWithTypeArgsNode(
  typeNode: ExpressionWithTypeArguments,
  fn: TypeRefCallback,
): void {
  const expression = typeNode.getExpression();
  if (expression.isKind(SyntaxKind.Identifier)) {
    fn(expression.getText());
  }
  for (const typeArg of typeNode.getTypeArguments()) {
    traverseTypeNodeWith(typeArg, fn);
  }
}


function traverseTypeParameterDeclarations(
  typeParams: TypeParameterDeclaration[],
  fn: TypeRefCallback,
): void {
  for (const tp of typeParams) {
    const constraint = tp.getConstraint();
    if (constraint) {
      traverseTypeNodeWith(constraint, fn);
    }
    const defaultType = tp.getDefault();
    if (defaultType) {
      traverseTypeNodeWith(defaultType, fn);
    }
  }
}


function traverseMappedTypeNode(
  typeNode: MappedTypeNode,
  fn: TypeRefCallback,
): void {
  traverseTypeParameterDeclarations([typeNode.getTypeParameter()], fn);
  traverseTypeNodeWith(typeNode.getTypeNode(), fn);
}


function traverseTemplateLiteralTypeNode(
  typeNode: TemplateLiteralTypeNode,
  fn: TypeRefCallback,
): void {
  for (const span of typeNode.getTemplateSpans()) {
    traverseTypeNodeWith(span, fn);
  }
}


function traverseImportTypeNode(
  typeNode: ImportTypeNode,
  fn: TypeRefCallback,
): void {
  // Traverses type arguments (e.g. import("mod").Default<T>).
  // The qualifier (e.g. .Foo in import("mod").Foo) is a value
  // reference on the module namespace — extract identifiers from it.
  for (const typeArg of typeNode.getTypeArguments()) {
    traverseTypeNodeWith(typeArg, fn);
  }
  const qualifier = typeNode.getQualifier();
  if (qualifier) {
    extractIdentifiersFromEntityName(qualifier, fn);
  }
}


function extractIdentifiersFromEntityName(
  entityName: Node,
  fn: TypeRefCallback,
): void {
  if (entityName.isKind(SyntaxKind.Identifier)) {
    fn(entityName.getText());
  } else {
    // QualifiedName: recurse through left/right chain
    for (const descendant of entityName.getDescendantsOfKind(SyntaxKind.Identifier)) {
      fn(descendant.getText());
    }
  }
}


function traverseConditionalTypeNode(
  conditionalType: ConditionalTypeNode,
  fn: TypeRefCallback,
): void {
  traverseTypeNodeWith(conditionalType.getCheckType(), fn);
  traverseTypeNodeWith(conditionalType.getExtendsType(), fn);
  traverseTypeNodeWith(conditionalType.getTrueType(), fn);
  traverseTypeNodeWith(conditionalType.getFalseType(), fn);
}


function traverseTypeLiteralNode(
  typeNode: TypeLiteralNode,
  fn: TypeRefCallback,
): void {
  for (const member of typeNode.getMembers()) {
    if (member.isKind(SyntaxKind.PropertySignature)) {
      traverseTypeNodeWith(member.getTypeNode(), fn);
    } else if (member.isKind(SyntaxKind.MethodSignature)) {
      traverseParamsAndReturn(member, fn);
    } else if (member.isKind(SyntaxKind.CallSignature)) {
      // ast-grep-ignore: no-type-assertion
      traverseParamsAndReturn(member as CallSignatureDeclaration, fn);
    } else if (member.isKind(SyntaxKind.ConstructSignature)) {
      // ast-grep-ignore: no-type-assertion
      traverseParamsAndReturn(member as ConstructSignatureDeclaration, fn);
    } else if (member.isKind(SyntaxKind.GetAccessor)) {
      // ast-grep-ignore: no-type-assertion
      traverseParamsAndReturn(member as GetAccessorDeclaration, fn);
    } else if (member.isKind(SyntaxKind.SetAccessor)) {
      // ast-grep-ignore: no-type-assertion
      traverseParamsAndReturn(member as SetAccessorDeclaration, fn);
    } else if (member.isKind(SyntaxKind.IndexSignature)) {
      // ast-grep-ignore: no-type-assertion
      const idxSig = member as IndexSignatureDeclaration;
      traverseTypeNodeWith(idxSig.getKeyTypeNode(), fn);
      traverseTypeNodeWith(idxSig.getReturnTypeNode(), fn);
    }
  }
}


/*
  TypeScript's getKind()-based narrowing doesn't narrow Node to the
  concrete subtype, so every case below casts after the kind check.
*/
function traverseTypeNodeWith(
  typeNode: TypeNode | undefined,
  fn: TypeRefCallback,
): void {
  if (!typeNode) {
    return;
  }

  switch (typeNode.getKind()) {
    case SyntaxKind.TypeReference:
      // ast-grep-ignore: no-type-assertion
      traverseTypeReferenceNode(typeNode as TypeReferenceNode, fn);
      return;
    case SyntaxKind.ExpressionWithTypeArguments:
      traverseExpressionWithTypeArgsNode(
        // ast-grep-ignore: no-type-assertion
        typeNode as ExpressionWithTypeArguments,
        fn,
      );
      return;
    case SyntaxKind.UnionType:
    case SyntaxKind.IntersectionType: {
      // ast-grep-ignore: no-type-assertion
      const unionOrIntersection = typeNode as unknown as {
        getTypeNodes(): TypeNode[];
      };
      for (const type of unionOrIntersection.getTypeNodes()) {
        traverseTypeNodeWith(type, fn);
      }
      return;
    }
    case SyntaxKind.ParenthesizedType: {
      // ast-grep-ignore: no-type-assertion
      const parenType = typeNode as ParenthesizedTypeNode;
      traverseTypeNodeWith(parenType.getTypeNode(), fn);
      return;
    }
    case SyntaxKind.ArrayType: {
      // ast-grep-ignore: no-type-assertion
      const arrayType = typeNode as ArrayTypeNode;
      traverseTypeNodeWith(arrayType.getElementTypeNode(), fn);
      return;
    }
    case SyntaxKind.IndexedAccessType: {
      // ast-grep-ignore: no-type-assertion
      const indexedAccess = typeNode as IndexedAccessTypeNode;
      traverseTypeNodeWith(indexedAccess.getObjectTypeNode(), fn);
      traverseTypeNodeWith(indexedAccess.getIndexTypeNode(), fn);
      return;
    }
    case SyntaxKind.TypeQuery: {
      // ast-grep-ignore: no-type-assertion
      const typeQuery = typeNode as TypeQueryNode;
      const exprName = typeQuery.getExprName();
      if (exprName.isKind(SyntaxKind.Identifier)) {
        fn(exprName.getText());
      }
      return;
    }
    case SyntaxKind.MappedType:
      // ast-grep-ignore: no-type-assertion
      traverseMappedTypeNode(typeNode as MappedTypeNode, fn);
      return;
    case SyntaxKind.FunctionType: {
      // ast-grep-ignore: no-type-assertion
      const funcType = typeNode as FunctionTypeNode;
      traverseTypeParameterDeclarations(funcType.getTypeParameters(), fn);
      traverseParamsAndReturn(funcType, fn);
      return;
    }
    case SyntaxKind.TypeLiteral:
      // ast-grep-ignore: no-type-assertion
      traverseTypeLiteralNode(typeNode as TypeLiteralNode, fn);
      return;
    case SyntaxKind.TupleType: {
      // ast-grep-ignore: no-type-assertion
      const tupleType = typeNode as TupleTypeNode;
      for (const element of tupleType.getElements()) {
        if (element.isKind(SyntaxKind.NamedTupleMember)) {
          traverseTypeNodeWith(element.getTypeNode(), fn);
        } else {
          traverseTypeNodeWith(element, fn);
        }
      }
      return;
    }
    case SyntaxKind.RestType: {
      // ast-grep-ignore: no-type-assertion
      const restType = typeNode as RestTypeNode;
      traverseTypeNodeWith(restType.getTypeNode(), fn);
      return;
    }
    case SyntaxKind.ConditionalType:
      // ast-grep-ignore: no-type-assertion
      traverseConditionalTypeNode(typeNode as ConditionalTypeNode, fn);
      return;
    case SyntaxKind.TypeOperator: {
      // ast-grep-ignore: no-type-assertion
      const typeOperator = typeNode as TypeOperatorTypeNode;
      traverseTypeNodeWith(typeOperator.getTypeNode(), fn);
      return;
    }
    case SyntaxKind.ConstructorType: {
      // ast-grep-ignore: no-type-assertion
      traverseParamsAndReturn(typeNode as ConstructorTypeNode, fn);
      return;
    }
    case SyntaxKind.TemplateLiteralType:
      // ast-grep-ignore: no-type-assertion
      traverseTemplateLiteralTypeNode(typeNode as TemplateLiteralTypeNode, fn);
      return;
    case SyntaxKind.ImportType:
      // ast-grep-ignore: no-type-assertion
      traverseImportTypeNode(typeNode as ImportTypeNode, fn);
      return;
    case SyntaxKind.TemplateLiteralTypeSpan: {
      // TemplateLiteralTypeSpan wraps an embedded type (e.g. ${T} in `hello ${T}`).
      // ts-morph doesn't expose a dedicated method, so traverse child TypeNodes.
      for (const child of typeNode.getChildren()) {
        if (Node.isTypeNode(child)) {
          traverseTypeNodeWith(child, fn);
        }
      }
      return;
    }
  }
}


/*
  Structural type for traverseParamsAndReturn — duck-typed to avoid
  listing every concrete subtype (FunctionLikeDeclaration, MethodSignature,
  CallSignatureDeclaration, etc.) separately. ArrowFunction and
  FunctionExpression satisfy this shape but are outside FunctionLikeDeclaration
  in ts-morph's nominal hierarchy, so a structural type is the practical fit.
*/
type ParamsAndReturnNode = {
  getParameters(): { getTypeNode(): TypeNode | undefined }[];
  getReturnTypeNode(): TypeNode | undefined;
};


function traverseParamsAndReturn(
  node: ParamsAndReturnNode,
  fn: TypeRefCallback,
): void {
  for (const param of node.getParameters()) {
    traverseTypeNodeWith(param.getTypeNode(), fn);
  }
  const returnTypeNode = node.getReturnTypeNode();
  traverseTypeNodeWith(returnTypeNode, fn);
}


function extractTypeRefsFromInterfaceDecl(
  node: InterfaceDeclaration,
  fn: TypeRefCallback,
): void {
  traverseTypeParameterDeclarations(node.getTypeParameters(), fn);
  for (const clause of node.getHeritageClauses()) {
    for (const type of clause.getTypeNodes()) {
      traverseTypeNodeWith(type, fn);
    }
  }
  for (const prop of node.getProperties()) {
    traverseTypeNodeWith(prop.getTypeNode(), fn);
  }
  for (const method of node.getMethods()) {
    traverseParamsAndReturn(method, fn);
  }
  for (const callSig of node.getCallSignatures()) {
    traverseParamsAndReturn(callSig, fn);
  }
  for (const constructSig of node.getConstructSignatures()) {
    traverseParamsAndReturn(constructSig, fn);
  }
  for (const idxSig of node.getIndexSignatures()) {
    traverseTypeNodeWith(idxSig.getKeyTypeNode(), fn);
    traverseTypeNodeWith(idxSig.getReturnTypeNode(), fn);
  }
  for (const accessor of node.getGetAccessors()) {
    traverseParamsAndReturn(accessor, fn);
  }
  for (const accessor of node.getSetAccessors()) {
    traverseParamsAndReturn(accessor, fn);
  }
}


function extractTypeRefsFromClassDecl(
  node: ClassDeclaration | ClassExpression,
  fn: TypeRefCallback,
): void {
  traverseTypeParameterDeclarations(node.getTypeParameters(), fn);
  for (const clause of node.getHeritageClauses()) {
    for (const type of clause.getTypeNodes()) {
      traverseTypeNodeWith(type, fn);
    }
  }
  for (const prop of node.getProperties()) {
    traverseTypeNodeWith(prop.getTypeNode(), fn);
  }
  for (const ctor of node.getConstructors()) {
    traverseParamsAndReturn(ctor, fn);
  }
  for (const method of node.getMethods()) {
    traverseParamsAndReturn(method, fn);
  }
  for (const accessor of node.getGetAccessors()) {
    traverseParamsAndReturn(accessor, fn);
  }
  for (const accessor of node.getSetAccessors()) {
    traverseParamsAndReturn(accessor, fn);
  }
  for (const idxSig of node.getDescendantsOfKind(SyntaxKind.IndexSignature)) {
    traverseTypeNodeWith(idxSig.getKeyTypeNode(), fn);
    traverseTypeNodeWith(idxSig.getReturnTypeNode(), fn);
  }
}


function collectMemberValueReferences(member: {
  getBody(): Node | undefined;
  getLocals(): { getName(): string }[];
}): string[] {
  const body = member.getBody();
  if (!body) {
    return [];
  }
  const locals = new Set(member.getLocals().map(function (sym) {
    return sym.getName();
  }));
  return collectIdentifierReferences(body).filter(function (n) {
    return !locals.has(n);
  });
}


/*
  Collects value references from a class property: computed property
  name expression and initializer. Static properties that reference
  other statics are class-internal and filtered out.
*/
function collectPropertyReferences(
  prop: { getName(): string; getNameNode(): Node; getInitializer(): Node | undefined; hasModifier(kind: number): boolean },
  staticPropNames: Set<string>,
): string[] {
  const references: string[] = [];
  const propertyName = prop.getName();
  const isStatic = prop.hasModifier(SyntaxKind.StaticKeyword);

  /*
    Computed property name expressions are evaluated in the outer scope.
    Static computed names that reference other statics are class-internal.
  */
  if (prop.getNameNode().isKind(SyntaxKind.ComputedPropertyName)) {
    const nameRefs = collectIdentifierReferences(prop.getNameNode());
    references.push(...(isStatic
      ? nameRefs.filter(function (ref) { return !staticPropNames.has(ref); })
      : nameRefs));
  }

  const initializer = prop.getInitializer();
  if (initializer) {
    const propRefs = collectIdentifierReferences(initializer).filter(function (ref) {
      if (ref === propertyName) {
        return false;
      }
      if (isStatic && staticPropNames.has(ref)) {
        return false;
      }
      return true;
    });
    references.push(...propRefs);
  }

  return references;
}


function collectClassBodyValueReferences(
  node: ClassDeclaration,
): string[] {
  const references: string[] = [];
  for (const ctor of node.getConstructors()) {
    /*
      Collect all parameter names first so that cross-parameter references
      (e.g. `constructor(public x = y, public y = z)`) are filtered out.
    */
    const paramNames = new Set(ctor.getParameters().map(function (p) { return p.getName(); }));
    for (const param of ctor.getParameters()) {
      const initializer = param.getInitializer();
      if (initializer) {
        const initRefs = collectIdentifierReferences(initializer).filter(function (ref) {
          return !paramNames.has(ref);
        });
        references.push(...initRefs);
      }
    }
    references.push(...collectMemberValueReferences(ctor));
  }
  for (const method of node.getMethods()) {
    references.push(...collectMemberValueReferences(method));
  }
  for (const accessor of node.getGetAccessors()) {
    references.push(...collectMemberValueReferences(accessor));
  }
  for (const accessor of node.getSetAccessors()) {
    references.push(...collectMemberValueReferences(accessor));
  }

  /*
    Static property initializers and static blocks can reference other
    static properties by name. Collect all static names first so we can
    filter class-internal cross-references from the result.
  */
  const staticPropNames = new Set<string>();
  for (const prop of node.getProperties()) {
    if (prop.hasModifier(SyntaxKind.StaticKeyword)) {
      staticPropNames.add(prop.getName());
    }
  }

  for (const staticBlock of node.getStaticBlocks()) {
    const blockRefs = collectMemberValueReferences(staticBlock).filter(function (ref) {
      return !staticPropNames.has(ref);
    });
    references.push(...blockRefs);
  }

  for (const prop of node.getProperties()) {
    references.push(...collectPropertyReferences(prop, staticPropNames));
  }
  return references;
}


function extractTypeReferences(node: Node): string[] {
  const typeReferences: string[] = [];
  const visited = new Set<string>();
  function addTypeReference(typeName: string): void {
    if (!visited.has(typeName)) {
      visited.add(typeName);
      typeReferences.push(typeName);
    }
  }
  if (node.isKind(SyntaxKind.FunctionDeclaration)) {
    const funcDecl =
      // ast-grep-ignore: no-type-assertion
      node as FunctionDeclaration;
    traverseTypeParameterDeclarations(funcDecl.getTypeParameters(), addTypeReference);
    traverseParamsAndReturn(funcDecl, addTypeReference);
  } else if (node.isKind(SyntaxKind.VariableDeclaration)) {
    traverseTypeNodeWith(node.getTypeNode(), addTypeReference);
  } else if (node.isKind(SyntaxKind.InterfaceDeclaration)) {
    extractTypeRefsFromInterfaceDecl(node, addTypeReference);
  } else if (node.isKind(SyntaxKind.ClassDeclaration)) {
    extractTypeRefsFromClassDecl(node, addTypeReference);
  } else if (node.isKind(SyntaxKind.ClassExpression)) {
    extractTypeRefsFromClassDecl(
      // ast-grep-ignore: no-type-assertion
      node as ClassExpression,
      addTypeReference,
    );
  } else if (node.isKind(SyntaxKind.TypeAliasDeclaration)) {
    // ast-grep-ignore: no-type-assertion
    const typeAlias = node as TypeAliasDeclaration;
    traverseTypeParameterDeclarations(typeAlias.getTypeParameters(), addTypeReference);
    traverseTypeNodeWith(typeAlias.getTypeNode(), addTypeReference);
  } else if (node.isKind(SyntaxKind.ArrowFunction)) {
    // ast-grep-ignore: no-type-assertion
    traverseParamsAndReturn(node as ArrowFunction, addTypeReference);
  } else if (node.isKind(SyntaxKind.FunctionExpression)) {
    // ast-grep-ignore: no-type-assertion
    traverseParamsAndReturn(node as FunctionExpression, addTypeReference);
  }
  return typeReferences;
}


/**
 * Details of a single import usage for a symbol.
 *
 * `importedName` is the original name in the source module (e.g. `'foo'` from
 * `import { foo } from './x'`), not the local alias.
 */
export type UseImport = {
  moduleSpec: string;
  importedName: string;
  isDefault: boolean;
  isTypeOnly: boolean;
  isNamespace: boolean;
};


function resolveIdentifierImport(
  usedIdentifier: string,
  unresolvedExports: Map<string, UnresolvedExport>,
): UseImport | null {
  const importInfo = unresolvedExports.get(usedIdentifier);
  if (!importInfo) {
    return null;
  }
  const isNamespace = importInfo.name === '*';
  const isDefault = importInfo.name === 'default';
  return {
    moduleSpec: importInfo.moduleSpec,
    importedName: isDefault || isNamespace ? usedIdentifier : importInfo.name,
    isDefault,
    isTypeOnly: importInfo.isTypeOnly,
    isNamespace,
  };
}


/**
 * Derive import usage information from StaticModuleInfo.
 * For each symbol tracked in `identifierUses` that references at least one
 * import, resolves identifier references to their import declarations and
 * returns deduplicated usage entries. Symbols with no import usage are omitted.
 */
export function analyzeImportUsageFromStaticInfo(
  moduleInfo: StaticModuleInfo,
): ImportUsage[] {
  const result: ImportUsage[] = [];

  for (const [symbolName, usedIdentifiers] of moduleInfo.identifierUses) {
    const seen = new Set<string>();
    const uniqueImports: UseImport[] = [];

    for (const usedIdentifier of usedIdentifiers) {
      const imp = resolveIdentifierImport(
        usedIdentifier,
        moduleInfo.unresolvedExportsByImportNames,
      );
      if (!imp) {
        continue;
      }
      const key = `${imp.moduleSpec}:${imp.importedName}:${imp.isTypeOnly}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueImports.push(imp);
      }
    }

    if (uniqueImports.length > 0) {
      result.push({ symbol: symbolName, usesImports: uniqueImports });
    }
  }

  return result;
}


/*
  Uses ts-morph's reliable getParent() chain rather than compilerNode.parent,
  which ts-morph does not maintain correctly.
*/
function isInTypeContext(node: Node): boolean {
  for (let parent = node.getParent(); parent; parent = parent.getParent()) {
    /* `typeof X` is a type expression but X is a runtime reference. */
    if (parent.getKind() === SyntaxKind.TypeQuery) {
      return false;
    }
    if (Node.isTypeNode(parent)) {
      return true;
    }
  }
  return false;
}


function isPropertyName(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) {
    return false;
  }
  if (
    Node.isPropertyAccessExpression(parent) &&
    parent.getNameNode() === node
  ) {
    return true;
  }
  if (
    (Node.isPropertyDeclaration(parent) || Node.isPropertySignature(parent) || Node.isPropertyAssignment(parent) || Node.isEnumMember(parent)) &&
    parent.getNameNode() === node
  ) {
    return true;
  }
  return false;
}


/**
 * Detect ambient (unbound) identifier references in a source file via a
 * single syntactic pass.
 *
 * This is the over-approximation tier of D12's two-tier ambient data model.
 * The result never misses a real ambient reference, making it safe for
 * scoping decisions.
 *
 * Reuses the sealed SourceFile passed to this function (via parseModule) rather
 * than creating another project. Uses collectAllDeclaredNames for all-scope
 * binding data.
 *
 * @returns Set of ambient name strings
 */
function detectAmbientNames(sourceFile: SourceFile): Set<string> {
  const locallyBound = collectAllDeclaredNames(sourceFile);
  const ambientNames = new Set<string>();

  sourceFile.forEachDescendant(function (node) {
    if (node.getKind() !== SyntaxKind.Identifier) {
      return;
    }
    const identifierText = node.getText();

    if (isPropertyName(node)) {
      return;
    }

    if (isInTypeContext(node)) {
      return;
    }

    if (locallyBound.has(identifierText)) {
      return;
    }

    ambientNames.add(identifierText);
  });

  return ambientNames;
}

function collectIdentifierReferences(node: Node): string[] {
  const identifiers: Node[] = node.isKind(SyntaxKind.Identifier)
    ? [node]
    : node.getDescendantsOfKind(SyntaxKind.Identifier);

  const references: string[] = [];
  for (const id of identifiers) {
    if (isPropertyName(id)) {
      continue;
    }
    if (isInTypeContext(id)) {
      continue;
    }
    references.push(id.getText());
  }
  return references;
}


function parseImportDeclaration(
  node: ImportDeclaration,
  staticModuleInfo: StaticModuleInfo,
): void {
  const moduleSpec = node.getModuleSpecifierValue();

  const importClause = node.getFirstChildByKind(SyntaxKind.ImportClause);
  if (!importClause) {
    staticModuleInfo.imports.push({
      moduleSpec,
      names: [],
      typeOnly: false,
    });
    return;
  }

  const clauseTypeOnly = importClause.isTypeOnly();

  const namedBindings = importClause.getFirstChildByKind(
    SyntaxKind.NamedImports,
  );

  if (namedBindings) {
    /*
      Group specifiers by per-specifier isTypeOnly status. The effective
      type-only flag for each specifier is clause-level OR inline `type`.
      Mixed imports (e.g. `import { type A, B }`) produce separate entries.
    */
    const typeOnlyNames: string[] = [];
    const valueNames: string[] = [];

    namedBindings.forEachChild(function (child: Node) {
      // ast-grep-ignore: no-type-assertion
      const importSpecifier = child as ImportSpecifier;
      const importedName = importSpecifier.getName();
      const localName = importSpecifier.getAliasNode()
        ?.getText()
        ?? importedName;
      const specifierTypeOnly = clauseTypeOnly || importSpecifier.isTypeOnly();

      staticModuleInfo.unresolvedExportsByImportNames.set(localName, {
        name: importedName,
        moduleSpec,
        isTypeOnly: specifierTypeOnly,
      });

      if (specifierTypeOnly) {
        typeOnlyNames.push(importedName);
      } else {
        valueNames.push(importedName);
      }
    });

    if (typeOnlyNames.length > 0) {
      staticModuleInfo.imports.push({
        moduleSpec,
        names: typeOnlyNames,
        typeOnly: true,
      });
    }
    if (valueNames.length > 0) {
      staticModuleInfo.imports.push({
        moduleSpec,
        names: valueNames,
        typeOnly: false,
      });
    }
  } else {
    const namespaceImport = importClause.getFirstChildByKind(
      SyntaxKind.NamespaceImport,
    );
    if (namespaceImport) {
      const nsName = namespaceImport.getName();
      staticModuleInfo.imports.push({
        moduleSpec,
        names: ['*'],
        typeOnly: clauseTypeOnly,
      });
      staticModuleInfo.unresolvedExportsByImportNames.set(nsName, {
        name: '*',
        moduleSpec,
        isTypeOnly: clauseTypeOnly,
      });
    } else {
      const defaultBinding = importClause.getFirstChildByKind(
        SyntaxKind.Identifier,
      );
      if (defaultBinding) {
        staticModuleInfo.imports.push({
          moduleSpec,
          names: ['default'],
          typeOnly: clauseTypeOnly,
        });
        staticModuleInfo.unresolvedExportsByImportNames.set(
          defaultBinding.getText(),
          { name: 'default', moduleSpec, isTypeOnly: clauseTypeOnly },
        );
      }
    }
  }
}


function parseVariableStatement(
  node: VariableStatement,
  staticModuleInfo: StaticModuleInfo,
): void {
  /* isExported() probes the filesystem. */
  const varExported = node.hasModifier(SyntaxKind.ExportKeyword);
  const decls = node.getDeclarations();

  for (const decl of decls) {
    const bindingNames = new Set<string>();
    addBindingName(decl.getNameNode(), bindingNames);
    parseVariableDeclaration(decl, bindingNames, varExported, staticModuleInfo);
  }
}


function parseVariableDeclaration(
  decl: VariableDeclaration,
  bindingNames: Set<string>,
  varExported: boolean,
  staticModuleInfo: StaticModuleInfo,
): void {
  if (varExported) {
    for (const bindingName of bindingNames) {
      staticModuleInfo.exportedNames.add(bindingName);
    }
  }

  const typeUses = extractTypeReferences(decl);
  const initializer = decl.getInitializer();

  if (initializer) {
    const valueUses = collectIdentifierReferences(initializer).filter(function (ref) {
      return !bindingNames.has(ref);
    });
    const initTypeUses = extractTypeReferences(initializer);
    for (const bindingName of bindingNames) {
      addIdentifierUses(staticModuleInfo, bindingName, typeUses);
      addIdentifierUses(staticModuleInfo, bindingName, valueUses);
      addIdentifierUses(staticModuleInfo, bindingName, initTypeUses);
    }
  } else {
    for (const bindingName of bindingNames) {
      addIdentifierUses(staticModuleInfo, bindingName, typeUses);
    }
  }
}


function parseFunctionDeclaration(
  node: FunctionDeclaration,
  staticModuleInfo: StaticModuleInfo,
): void {
  /* isExported() probes the filesystem. */
  const exported = node.hasModifier(SyntaxKind.ExportKeyword);

  /* Anonymous function declarations only appear as `export default function() {}`; use 'default' as the tracking key. */
  const name = node.getName() ?? 'default';

  const valueUses = collectMemberValueReferences(node);
  addIdentifierUses(staticModuleInfo, name, valueUses);

  if (exported) {
    staticModuleInfo.exportedNames.add(name);
  }

  const typeUses = extractTypeReferences(node);
  addIdentifierUses(staticModuleInfo, name, typeUses);
}


function parseClassDeclaration(
  node: ClassDeclaration,
  staticModuleInfo: StaticModuleInfo,
): void {
  /* isExported() probes the filesystem. */
  const exported = node.hasModifier(SyntaxKind.ExportKeyword);
  const name = node.getName() ?? 'default';

  if (exported) {
    staticModuleInfo.exportedNames.add(name);
  }
  const typeUses = extractTypeReferences(node);
  addIdentifierUses(staticModuleInfo, name, typeUses);
  const valueUses = collectClassBodyValueReferences(node);
  addIdentifierUses(staticModuleInfo, name, valueUses);
}


function parseEnumDeclaration(
  node: EnumDeclaration,
  staticModuleInfo: StaticModuleInfo,
): void {
  const exported = node.hasModifier(SyntaxKind.ExportKeyword);
  const enumName = node.getName();

  if (exported) {
    staticModuleInfo.exportedNames.add(enumName);
  }

  const memberNames = new Set(node.getMembers().map(function (m) { return m.getName(); }));

  for (const member of node.getMembers()) {
    const initializer = member.getInitializer();
    if (initializer) {
      const valueUses = collectIdentifierReferences(initializer).filter(function (ref) {
        return !memberNames.has(ref);
      });
      addIdentifierUses(staticModuleInfo, enumName, valueUses);
    }
  }
}


function parseExportAssignment(
  node: ExportAssignment,
  staticModuleInfo: StaticModuleInfo,
): void {
  staticModuleInfo.exportedNames.add('default');
  // biome-ignore lint/style/noNonNullAssertion: ExportAssignment grammar guarantees an expression
  const expression = node.getExpression()!;
  /* Named class/function expressions bind their name within the expression scope, so filter it out. */
  let selfBindingName: string | undefined;
  if (expression.isKind(SyntaxKind.ClassExpression)) {
    // ast-grep-ignore: no-type-assertion
    selfBindingName = (expression as ClassExpression).getName();
  } else if (expression.isKind(SyntaxKind.FunctionExpression)) {
    // ast-grep-ignore: no-type-assertion
    selfBindingName = (expression as FunctionExpression).getName();
  }
  const valueUses = collectIdentifierReferences(expression).filter(function (ref) {
    return selfBindingName === undefined || ref !== selfBindingName;
  });
  addIdentifierUses(staticModuleInfo, 'default', valueUses);
  const typeUses = extractTypeReferences(expression);
  addIdentifierUses(staticModuleInfo, 'default', typeUses);
}


/**
 * Parse export declaration (re-exports).
 *
 * Handles:
 * 1. `export { x } from 'module'` — direct re-export with module specifier
 * 2. `export { x }` — bare re-export of a local import binding
 * 3. `export * as ns from 'module'` — namespace re-export
 * 4. `export * from 'module'` — star re-export (tracked with name `'*'`)
 *
 * Bare exports resolve the local name through `unresolvedExportsByImportNames`
 * to find the original import module. Non-import bindings are tracked only in
 * `exportedNames`.
 */
function parseExportDeclaration(
  node: ExportDeclaration,
  staticModuleInfo: StaticModuleInfo,
): void {
  const isTypeOnly = node.isTypeOnly();
  const moduleSpec = node.getModuleSpecifierValue();

  const namespaceExport = node.getNamespaceExport();
  if (namespaceExport) {
    /* `export * as ns from 'module'` */
    const exportedName = namespaceExport.getName();
    staticModuleInfo.exportedNames.add(exportedName);
    if (moduleSpec) {
      staticModuleInfo.reExports.push({
        name: exportedName,
        moduleSpec,
        isTypeOnly,
      });
    }
    return;
  }

  const namedExports = node.getNamedExports();
  if (namedExports.length > 0) {
    namedExports.forEach(function (namedExport) {
      const localName = namedExport.getName();
      const exportedName = namedExport.getAliasNode()
        ?.getText()
        ?? localName;
      const exportTypeOnly = isTypeOnly || namedExport.isTypeOnly();

      staticModuleInfo.exportedNames.add(exportedName);

      if (moduleSpec) {
        /* Direct re-export: `export { x } from 'module'` */
        staticModuleInfo.reExports.push({
          name: exportedName,
          moduleSpec,
          isTypeOnly: exportTypeOnly,
        });
      } else {
        /*
          Bare export: `export { x }` — re-export of a local binding.
          Resolve the local name through the import map to find the
          original import module.
        */
        const importInfo =
          staticModuleInfo.unresolvedExportsByImportNames.get(localName);
        if (importInfo) {
          staticModuleInfo.reExports.push({
            name: exportedName,
            moduleSpec: importInfo.moduleSpec,
            isTypeOnly: exportTypeOnly,
          });
        }
      }
    });
  } else {
    /* Star re-export: `export * from 'module'` */
    if (moduleSpec) {
      staticModuleInfo.reExports.push({
        name: '*',
        moduleSpec,
        isTypeOnly,
      });
    }
  }
}


/**
 * Parse a source file into static module information.
 *
 * @param sourceFile - SourceFile from a sealed in-memory project.
 *   This function calls getLocals() internally (via collectMemberValueReferences
 *   and detectAmbientNames), which triggers ts.Program creation. An unsealed
 *   source file would cause the program to resolve imports against the real
 *   filesystem, pulling in the entire dependency graph.
 * @returns Static module analysis results
 */
export function parseModule(sourceFile: SourceFile): StaticModuleInfo {
  const staticModuleInfo: StaticModuleInfo = {
    imports: [],
    unresolvedExportsByImportNames: new Map<string, UnresolvedExport>(),
    identifierUses: new Map<string, string[]>(),
    exportedNames: new Set<string>(),
    reExports: [],
    ambientNames: new Set<string>(),
  };

  /*
    First pass: collect all imports so that bare `export { x }` can
    resolve local names against the populated import map.
  */
  sourceFile.forEachChild(function (node) {
    if (node.getKind() === SyntaxKind.ImportDeclaration) {
      // ast-grep-ignore: no-type-assertion
      parseImportDeclaration(node as ImportDeclaration, staticModuleInfo);
    }
  });

  sourceFile.forEachChild(function (node) {
    const kind = node.getKind();
    switch (kind) {
      case SyntaxKind.VariableStatement:
        // ast-grep-ignore: no-type-assertion
        parseVariableStatement(node as VariableStatement, staticModuleInfo);
        break;
      case SyntaxKind.FunctionDeclaration:
        // ast-grep-ignore: no-type-assertion
        parseFunctionDeclaration(node as FunctionDeclaration, staticModuleInfo);
        break;
      case SyntaxKind.ClassDeclaration:
        // ast-grep-ignore: no-type-assertion
        parseClassDeclaration(node as ClassDeclaration, staticModuleInfo);
        break;
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration: {
        // ast-grep-ignore: no-type-assertion
        const decl = node as InterfaceDeclaration | TypeAliasDeclaration;
        const exported = decl.hasModifier(SyntaxKind.ExportKeyword);
        const isDefaultExport = decl.hasModifier(SyntaxKind.DefaultKeyword);
        const name = decl.getName();
        if (exported) {
          staticModuleInfo.exportedNames.add(isDefaultExport ? 'default' : name);
        }
        const typeUses = extractTypeReferences(decl);
        addIdentifierUses(staticModuleInfo, name, typeUses);
        break;
      }
      case SyntaxKind.EnumDeclaration:
        // ast-grep-ignore: no-type-assertion
        parseEnumDeclaration(node as EnumDeclaration, staticModuleInfo);
        break;
      case SyntaxKind.ExportDeclaration:
        // ast-grep-ignore: no-type-assertion
        parseExportDeclaration(node as ExportDeclaration, staticModuleInfo);
        break;
      case SyntaxKind.ExportAssignment:
        // ast-grep-ignore: no-type-assertion
        parseExportAssignment(node as ExportAssignment, staticModuleInfo);
        break;
    }
  });

  /* Detect ambient names (over-approximation for index storage, D12). */
  staticModuleInfo.ambientNames = detectAmbientNames(sourceFile);

  return staticModuleInfo;
}
