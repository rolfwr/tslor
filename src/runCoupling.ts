import { Node, Project, SyntaxKind, type ClassDeclaration } from 'ts-morph';

/**
 * Directed member dependency graph.
 *
 * Keys are class member names, values are names of members the key depends on
 * via `this.X` references in executable member bodies.
 */
export type CouplingGraph = Map<string, Set<string>>;

interface ClassMemberDefinition {
  name: string;
  executableBody: Node | null;
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

function findTargetClass(filePath: string, className: string): ClassDeclaration {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  const sourceFile = project.addSourceFileAtPath(filePath);
  const classDeclaration = sourceFile.getClass(className);
  if (classDeclaration === undefined) {
    throw new Error(`Class ${className} not found in ${filePath}`);
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
      name,
      executableBody: getExecutableBody(member),
    });
  }

  return members;
}

function createGraphNodes(members: ReadonlyArray<ClassMemberDefinition>): CouplingGraph {
  const graph: CouplingGraph = new Map();

  for (const member of members) {
    if (!graph.has(member.name)) {
      graph.set(member.name, new Set());
    }
  }

  return graph;
}

function collectThisAccessDependencies(body: Node): Set<string> {
  const dependencies = new Set<string>();

  for (const access of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (!Node.isThisExpression(access.getExpression())) {
      continue;
    }

    dependencies.add(access.getName());
  }

  return dependencies;
}

function populateGraphEdges(
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

    for (const dependencyName of collectThisAccessDependencies(member.executableBody)) {
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

/**
 * Parse class-scope member coupling from one file.
 *
 * The graph includes class fields, methods, constructors, and arrow-function
 * properties as nodes. Edges are added for `this.X` references from each
 * executable member body to another member `X` in the same class.
 */
export function parseClassCoupling(filePath: string, className: string): CouplingGraph {
  const targetClass = findTargetClass(filePath, className);
  const members = collectClassMembers(targetClass);
  const graph = createGraphNodes(members);

  populateGraphEdges(graph, members);

  return graph;
}
