import {
  Node,
  Project,
  SyntaxKind,
  type ClassDeclaration,
  type ClassElement,
  type Identifier,
  type PropertyAccessExpression,
  type SourceFile,
} from 'ts-morph';

/**
 * Directed member dependency graph.
 *
 * Keys are declaration names, values are names of declarations the key depends on.
 */
export type CouplingGraph = Map<string, Set<string>>;

interface ClassMemberDefinition {
  declaration: ClassElement;
  name: string;
  executableBody: Node | null;
}

interface ModuleMemberDefinition {
  declarations: ReadonlyArray<Node>;
  executableBodies: ReadonlyArray<Node>;
  name: string;
}

interface MutableModuleMemberDefinition {
  declarations: Node[];
  executableBodies: Node[];
}

function requiredMapGet<K, V>(
  map: ReadonlyMap<K, V>,
  key: K,
  context: string
): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Expected ${context} to exist`);
  }

  return value;
}

function loadSourceFile(filePath: string): SourceFile {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  return project.addSourceFileAtPath(filePath);
}

function findTargetClass(sourceFile: SourceFile, className: string): ClassDeclaration {
  const classDeclaration = sourceFile.getClass(className);
  if (classDeclaration === undefined) {
    throw new Error(`Class ${className} not found in ${sourceFile.getFilePath()}`);
  }

  return classDeclaration;
}

function getMemberName(member: Node): string | null {
  if (Node.isMethodDeclaration(member)) {
    return member.getName();
  }

  if (Node.isPropertyDeclaration(member)) {
    return member.getName();
  }

  if (Node.isConstructorDeclaration(member)) {
    return 'constructor';
  }

  return null;
}

function getExecutableBody(member: Node): Node | null {
  if (Node.isMethodDeclaration(member)) {
    return member.getBody() ?? null;
  }

  if (Node.isConstructorDeclaration(member)) {
    return member.getBody() ?? null;
  }

  if (Node.isPropertyDeclaration(member)) {
    const initializer = member.getInitializer();
    if (initializer !== undefined && Node.isArrowFunction(initializer)) {
      return initializer.getBody();
    }
  }

  return null;
}

function collectClassMembers(classDeclaration: ClassDeclaration): ClassMemberDefinition[] {
  const members: ClassMemberDefinition[] = [];

  for (const member of classDeclaration.getMembers()) {
    const name = getMemberName(member);
    if (name === null) {
      continue;
    }

    members.push({
      declaration: member,
      name,
      executableBody: getExecutableBody(member),
    });
  }

  return members;
}

function createGraphNodes(memberNames: ReadonlyArray<string>): CouplingGraph {
  const graph: CouplingGraph = new Map();

  for (const memberName of memberNames) {
    if (!graph.has(memberName)) {
      graph.set(memberName, new Set());
    }
  }

  return graph;
}

function isThisBindingScope(node: Node): boolean {
  return (
    Node.isPropertyDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

function isClassThisAccess(access: Node, owningDeclaration: ClassElement): boolean {
  const nearestNonArrowThisScope = access.getFirstAncestor((ancestor) => {
    if (Node.isArrowFunction(ancestor)) {
      return false;
    }

    return isThisBindingScope(ancestor);
  });

  return nearestNonArrowThisScope === owningDeclaration;
}

function getPropertyAccesses(
  node: Node
): ReadonlyArray<PropertyAccessExpression> {
  const descendantAccesses = node.getDescendantsOfKind(
    SyntaxKind.PropertyAccessExpression
  );

  if (Node.isPropertyAccessExpression(node)) {
    return [node, ...descendantAccesses];
  }

  return descendantAccesses;
}

function collectThisAccessDependencies(
  body: Node,
  owningDeclaration: ClassElement
): Set<string> {
  const dependencies = new Set<string>();

  for (const access of getPropertyAccesses(body)) {
    if (!Node.isThisExpression(access.getExpression())) {
      continue;
    }

    if (!isClassThisAccess(access, owningDeclaration)) {
      continue;
    }

    dependencies.add(access.getName());
  }

  return dependencies;
}

function populateClassGraphEdges(
  graph: CouplingGraph,
  members: ReadonlyArray<ClassMemberDefinition>
): void {
  const memberNames = new Set(graph.keys());

  for (const member of members) {
    if (member.executableBody === null) {
      continue;
    }

    const sourceDependencies = requiredMapGet(
      graph,
      member.name,
      `coupling graph node for member ${member.name}`
    );

    for (const dependencyName of collectThisAccessDependencies(
      member.executableBody,
      member.declaration
    )) {
      if (dependencyName === member.name) {
        continue;
      }

      if (!memberNames.has(dependencyName)) {
        continue;
      }

      sourceDependencies.add(dependencyName);
    }
  }
}

function buildClassCouplingGraph(classDeclaration: ClassDeclaration): CouplingGraph {
  const members = collectClassMembers(classDeclaration);
  const graph = createGraphNodes(members.map((member) => member.name));

  populateClassGraphEdges(graph, members);

  return graph;
}

function addModuleMember(
  members: Map<string, MutableModuleMemberDefinition>,
  name: string,
  declaration: Node,
  executableBodies: ReadonlyArray<Node>
): void {
  const existing = members.get(name);
  if (existing === undefined) {
    members.set(name, {
      declarations: [declaration],
      executableBodies: [...executableBodies],
    });
    return;
  }

  existing.declarations.push(declaration);
  existing.executableBodies.push(...executableBodies);
}

function getCallableMemberBody(member: ClassElement): Node | null {
  if (
    Node.isMethodDeclaration(member) ||
    Node.isConstructorDeclaration(member) ||
    Node.isGetAccessorDeclaration(member) ||
    Node.isSetAccessorDeclaration(member)
  ) {
    return member.getBody() ?? null;
  }

  return null;
}

function getPropertyExecutableBodies(member: ClassElement): Node[] {
  if (!Node.isPropertyDeclaration(member)) {
    return [];
  }

  const initializer = member.getInitializer();
  if (initializer === undefined) {
    return [];
  }

  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    return [initializer.getBody()];
  }

  return [initializer];
}

function getClassMemberExecutableBodies(member: ClassElement): Node[] {
  const callableBody = getCallableMemberBody(member);
  if (callableBody !== null) {
    return [callableBody];
  }

  if (Node.isClassStaticBlockDeclaration(member)) {
    return [member.getBody()];
  }

  return getPropertyExecutableBodies(member);
}

function collectClassExecutableBodies(classDeclaration: ClassDeclaration): Node[] {
  const executableBodies: Node[] = [];

  for (const member of classDeclaration.getMembers()) {
    executableBodies.push(...getClassMemberExecutableBodies(member));
  }

  return executableBodies;
}

function getVariableExecutableBodies(variableDeclaration: Node): ReadonlyArray<Node> {
  if (!Node.isVariableDeclaration(variableDeclaration)) {
    return [];
  }

  const initializer = variableDeclaration.getInitializer();
  if (initializer === undefined) {
    return [];
  }

  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    return [initializer.getBody()];
  }

  return [initializer];
}

function collectFunctionDeclarationMember(
  statement: Node,
  memberCollectors: Map<string, MutableModuleMemberDefinition>
): boolean {
  if (!Node.isFunctionDeclaration(statement)) {
    return false;
  }

  const name = statement.getName();
  if (name === undefined) {
    return true;
  }

  const body = statement.getBody();
  addModuleMember(memberCollectors, name, statement, body === undefined ? [] : [body]);

  return true;
}

function collectClassDeclarationMember(
  statement: Node,
  memberCollectors: Map<string, MutableModuleMemberDefinition>
): boolean {
  if (!Node.isClassDeclaration(statement)) {
    return false;
  }

  const name = statement.getName();
  if (name === undefined) {
    return true;
  }

  addModuleMember(
    memberCollectors,
    name,
    statement,
    collectClassExecutableBodies(statement)
  );

  return true;
}

function collectVariableStatementMembers(
  statement: Node,
  memberCollectors: Map<string, MutableModuleMemberDefinition>
): boolean {
  if (!Node.isVariableStatement(statement)) {
    return false;
  }

  for (const declaration of statement.getDeclarations()) {
    addModuleMember(
      memberCollectors,
      declaration.getName(),
      declaration,
      getVariableExecutableBodies(declaration)
    );
  }

  return true;
}

function collectInterfaceDeclarationMember(
  statement: Node,
  memberCollectors: Map<string, MutableModuleMemberDefinition>
): boolean {
  if (!Node.isInterfaceDeclaration(statement)) {
    return false;
  }

  addModuleMember(memberCollectors, statement.getName(), statement, []);

  return true;
}

function collectTypeAliasDeclarationMember(
  statement: Node,
  memberCollectors: Map<string, MutableModuleMemberDefinition>
): boolean {
  if (!Node.isTypeAliasDeclaration(statement)) {
    return false;
  }

  addModuleMember(memberCollectors, statement.getName(), statement, []);

  return true;
}

function toModuleMemberDefinitions(
  memberCollectors: ReadonlyMap<string, MutableModuleMemberDefinition>
): ModuleMemberDefinition[] {
  const members: ModuleMemberDefinition[] = [];

  for (const [name, memberCollector] of memberCollectors) {
    members.push({
      declarations: memberCollector.declarations,
      executableBodies: memberCollector.executableBodies,
      name,
    });
  }

  return members;
}

function collectModuleMembers(sourceFile: SourceFile): ModuleMemberDefinition[] {
  const memberCollectors = new Map<string, MutableModuleMemberDefinition>();

  for (const statement of sourceFile.getStatements()) {
    if (collectFunctionDeclarationMember(statement, memberCollectors)) {
      continue;
    }

    if (collectClassDeclarationMember(statement, memberCollectors)) {
      continue;
    }

    if (collectVariableStatementMembers(statement, memberCollectors)) {
      continue;
    }

    if (collectInterfaceDeclarationMember(statement, memberCollectors)) {
      continue;
    }

    collectTypeAliasDeclarationMember(statement, memberCollectors);
  }

  return toModuleMemberDefinitions(memberCollectors);
}

function getIdentifiers(node: Node): ReadonlyArray<Identifier> {
  const descendantIdentifiers = node.getDescendantsOfKind(SyntaxKind.Identifier);

  if (Node.isIdentifier(node)) {
    return [node, ...descendantIdentifiers];
  }

  return descendantIdentifiers;
}

function isBareIdentifier(identifier: Identifier): boolean {
  const parent = identifier.getParent();
  if (parent === undefined) {
    return true;
  }

  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
    return false;
  }

  if (Node.isQualifiedName(parent) && parent.getRight() === identifier) {
    return false;
  }

  return true;
}

function resolveModuleDependencyName(
  identifier: Identifier,
  moduleDeclarations: ReadonlyMap<string, ReadonlyArray<Node>>
): string | null {
  if (!isBareIdentifier(identifier)) {
    return null;
  }

  const candidateName = identifier.getText();
  const candidateDeclarations = moduleDeclarations.get(candidateName);
  if (candidateDeclarations === undefined) {
    return null;
  }

  const symbol = identifier.getSymbol();
  if (symbol === undefined) {
    return null;
  }

  const resolvedSymbol = symbol.getAliasedSymbol() ?? symbol;
  const symbolDeclarations = resolvedSymbol.getDeclarations();

  for (const symbolDeclaration of symbolDeclarations) {
    if (candidateDeclarations.includes(symbolDeclaration)) {
      return candidateName;
    }
  }

  return null;
}

function populateModuleGraphEdges(
  graph: CouplingGraph,
  members: ReadonlyArray<ModuleMemberDefinition>
): void {
  const declarationsByName = new Map<string, ReadonlyArray<Node>>();
  for (const member of members) {
    declarationsByName.set(member.name, member.declarations);
  }

  for (const member of members) {
    const sourceDependencies = requiredMapGet(
      graph,
      member.name,
      `coupling graph node for declaration ${member.name}`
    );

    for (const executableBody of member.executableBodies) {
      for (const identifier of getIdentifiers(executableBody)) {
        const dependencyName = resolveModuleDependencyName(
          identifier,
          declarationsByName
        );
        if (dependencyName === null || dependencyName === member.name) {
          continue;
        }

        sourceDependencies.add(dependencyName);
      }
    }
  }
}

function buildModuleCouplingGraph(sourceFile: SourceFile): CouplingGraph {
  const members = collectModuleMembers(sourceFile);
  const graph = createGraphNodes(members.map((member) => member.name));

  populateModuleGraphEdges(graph, members);

  return graph;
}

/**
 * Parse class-scope member coupling from one file.
 *
 * The graph includes class fields, methods, constructors, and arrow-function
 * properties as nodes. Edges are added for `this.X` references from each
 * executable member body to another member `X` in the same class.
 */
export function parseClassCoupling(filePath: string, className: string): CouplingGraph {
  const sourceFile = loadSourceFile(filePath);
  return buildClassCouplingGraph(findTargetClass(sourceFile, className));
}

/**
 * Parse module-scope member coupling from one file.
 *
 * The graph includes top-level function declarations, class declarations,
 * variable declarations, interfaces, and type aliases as nodes. Edges are
 * added for bare-name references that resolve to another module declaration.
 */
export function parseModuleCoupling(filePath: string): CouplingGraph {
  return buildModuleCouplingGraph(loadSourceFile(filePath));
}
