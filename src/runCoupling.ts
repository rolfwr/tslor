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
import {
  computeTopologicalDepth,
  condenseToDAG,
  findSCCs,
  partitionLeafSccsByDistance,
  type SCC,
} from './graphUtils';

/**
 * Directed member dependency graph.
 *
 * Keys are declaration names, values are names of declarations the key depends on.
 */
export type CouplingGraph = ReadonlyMap<string, ReadonlySet<string>>;

type MutableCouplingGraph = Map<string, Set<string>>;

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

  if (Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
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

  if (Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
    return member.getBody() ?? null;
  }

  if (Node.isConstructorDeclaration(member)) {
    return member.getBody() ?? null;
  }

  if (Node.isPropertyDeclaration(member)) {
    const initializer = member.getInitializer();
    if (initializer === undefined) {
      return null;
    }

    if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
      return initializer.getBody();
    }

    return initializer;
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

function createGraphNodes(memberNames: ReadonlyArray<string>): MutableCouplingGraph {
  const graph: MutableCouplingGraph = new Map();

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
  graph: MutableCouplingGraph,
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

function buildClassCouplingGraph(classDeclaration: ClassDeclaration): MutableCouplingGraph {
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

interface VariableBinding {
  declaration: Node;
  name: string;
}

function collectVariablePatternBindings(
  nameNode: Node,
  bindings: VariableBinding[]
): void {
  if (Node.isIdentifier(nameNode)) {
    const bindingElement = nameNode.getFirstAncestorByKind(SyntaxKind.BindingElement);
    if (bindingElement === undefined) {
      return;
    }

    bindings.push({ declaration: bindingElement, name: nameNode.getText() });
    return;
  }

  if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.getElements()) {
      if (Node.isBindingElement(element)) {
        collectVariablePatternBindings(element.getNameNode(), bindings);
      }
    }
  }
}

function collectVariableBindings(variableDeclaration: Node): VariableBinding[] {
  if (!Node.isVariableDeclaration(variableDeclaration)) {
    return [];
  }

  const nameNode = variableDeclaration.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    return [{ declaration: variableDeclaration, name: nameNode.getText() }];
  }

  const bindings: VariableBinding[] = [];
  collectVariablePatternBindings(nameNode, bindings);
  return bindings;
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
    const executableBodies = getVariableExecutableBodies(declaration);
    for (const binding of collectVariableBindings(declaration)) {
      addModuleMember(
        memberCollectors,
        binding.name,
        binding.declaration,
        executableBodies
      );
    }
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
  graph: MutableCouplingGraph,
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

function buildModuleCouplingGraph(sourceFile: SourceFile): MutableCouplingGraph {
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

/**
 * Options for the `tslor coupling` command runner.
 */
export interface RunCouplingOptions {
  class?: string;
  graphviz?: boolean;
  graphvizDepthZeroOneSubset?: boolean;
  output?: CouplingOutput;
}

/**
 * Optional output sink for `runCoupling`.
 */
export interface CouplingOutput {
  /**
   * Write one complete rendered coupling report.
   *
   * The text is already fully formatted (either human-readable text or DOT).
   */
  write(text: string): void;
}

/**
 * Result of SCC/depth analysis over a coupling graph.
 */
export interface CouplingAnalysis {
  dag: ReadonlyMap<number, ReadonlySet<number>>;
  depthByScc: ReadonlyMap<number, number>;
  sccs: ReadonlyArray<SCC>;
}

interface DotColor {
  blue: number;
  green: number;
  red: number;
}

function analyzeCouplingGraph(graph: CouplingGraph): CouplingAnalysis {
  const sccs = findSCCs(graph);
  const dag = condenseToDAG(graph, sccs);
  const depthByScc = computeTopologicalDepth(dag);

  return {
    dag,
    depthByScc,
    sccs,
  };
}

function requiredDepth(
  depthByScc: ReadonlyMap<number, number>,
  sccIndex: number
): number {
  const depth = depthByScc.get(sccIndex);
  if (depth === undefined) {
    throw new Error(`Expected topological depth for SCC ${String(sccIndex)}`);
  }

  return depth;
}

function compareSccIndices(
  leftSccIndex: number,
  rightSccIndex: number,
  sccs: ReadonlyArray<SCC>
): number {
  const leftMembers = sccs[leftSccIndex];
  const rightMembers = sccs[rightSccIndex];
  if (leftMembers === undefined || rightMembers === undefined) {
    throw new Error(
      `Missing SCC members while sorting (left=${String(leftSccIndex)}, right=${String(rightSccIndex)}, total=${String(sccs.length)})`
    );
  }

  return leftMembers.join(',').localeCompare(rightMembers.join(','));
}

function formatTextHeader(filePath: string, options: RunCouplingOptions): string {
  const scope =
    options.class === undefined
      ? 'module scope'
      : `class scope (${options.class})`;
  return `Coupling analysis for ${filePath} (${scope})`;
}

type SccDepthSortDirection = 'ascending' | 'descending';

function compareSccTreeOrder(
  leftSccIndex: number,
  rightSccIndex: number,
  analysis: CouplingAnalysis,
  direction: SccDepthSortDirection
): number {
  const leftDepth = requiredDepth(analysis.depthByScc, leftSccIndex);
  const rightDepth = requiredDepth(analysis.depthByScc, rightSccIndex);

  if (leftDepth !== rightDepth) {
    return direction === 'descending'
      ? rightDepth - leftDepth
      : leftDepth - rightDepth;
  }

  return compareSccIndices(leftSccIndex, rightSccIndex, analysis.sccs);
}

function formatSccTreeLine(
  sccIndex: number,
  sccMembers: SCC,
  depth: number,
  indent: string
): string {
  return `${indent}Group-${String(depth)}-${String(sccIndex + 1)}: ${sccMembers.join(', ')}`;
}

function sortedSccIndices(
  sccIndices: Iterable<number>,
  analysis: CouplingAnalysis,
  direction: SccDepthSortDirection
): number[] {
  return [...sccIndices].sort((left, right) =>
    compareSccTreeOrder(left, right, analysis, direction)
  );
}

function formatNestedSccLines(
  analysis: CouplingAnalysis,
  dag: ReadonlyMap<number, ReadonlySet<number>>,
  direction: SccDepthSortDirection
): string[] {
  const lines: string[] = [];
  const printedSccs = new Set<number>();
  const unprintedSccs = new Set<number>(analysis.sccs.keys());

  function printScc(sccIndex: number, indent: string): void {
    const sccMembers = analysis.sccs[sccIndex];
    if (sccMembers === undefined) {
      throw new Error(`Expected SCC members for SCC index ${String(sccIndex)}`);
    }

    const depth = requiredDepth(analysis.depthByScc, sccIndex);
    const dependencies = dag.get(sccIndex);
    if (dependencies === undefined) {
      throw new Error(`Expected DAG dependencies for SCC ${String(sccIndex)}`);
    }

    const linePrefix = formatSccTreeLine(sccIndex, sccMembers, depth, indent);

    if (dependencies.size === 0) {
      lines.push(`${linePrefix}.`);
      printedSccs.add(sccIndex);
      unprintedSccs.delete(sccIndex);
      return;
    }

    if (printedSccs.has(sccIndex)) {
      lines.push(`${linePrefix}...`);
      return;
    }

    lines.push(`${linePrefix}:`);
    printedSccs.add(sccIndex);
    unprintedSccs.delete(sccIndex);

    for (const dependencySccIndex of sortedSccIndices(dependencies, analysis, direction)) {
      printScc(dependencySccIndex, `${indent}  `);
    }
  }

  while (unprintedSccs.size > 0) {
    const [nextSccIndex] = sortedSccIndices(unprintedSccs, analysis, direction);
    if (nextSccIndex === undefined) {
      throw new Error('Expected at least one SCC while rendering coupling text');
    }

    printScc(nextSccIndex, '');
  }

  return lines;
}

function reverseDag(
  dag: ReadonlyMap<number, ReadonlySet<number>>
): ReadonlyMap<number, ReadonlySet<number>> {
  const reversed = new Map<number, Set<number>>();

  for (const sccIndex of dag.keys()) {
    reversed.set(sccIndex, new Set<number>());
  }

  for (const [fromSccIndex, dependencies] of dag) {
    for (const toSccIndex of dependencies) {
      const dependents = reversed.get(toSccIndex);
      if (dependents === undefined) {
        throw new Error(`Expected reversed DAG node for SCC ${String(toSccIndex)}`);
      }

      dependents.add(fromSccIndex);
    }
  }

  return reversed;
}

function formatLeafClusterMembers(
  label: string,
  cluster: ReadonlyArray<number>,
  analysis: CouplingAnalysis
): string {
  if (cluster.length === 0) {
    return `${label}: (none)`;
  }

  const memberNames = sortedSccIndices(cluster, analysis, 'ascending').flatMap((sccIndex) => {
    const sccMembers = analysis.sccs[sccIndex];
    if (sccMembers === undefined) {
      throw new Error(`Expected SCC members for SCC index ${String(sccIndex)}`);
    }

    return sccMembers;
  });

  return `${label}: ${memberNames.join(', ')}`;
}

interface DepthZeroOneSubsetGraph {
  dag: ReadonlyMap<number, ReadonlySet<number>>;
  sccIndices: number[];
}

function isDepthZeroOrOne(
  depthByScc: ReadonlyMap<number, number>,
  sccIndex: number
): boolean {
  return requiredDepth(depthByScc, sccIndex) <= 1;
}

function collectDepthZeroOneSccIndices(analysis: CouplingAnalysis): number[] {
  const subsetSccIndices: number[] = [];

  for (const sccIndex of analysis.sccs.keys()) {
    if (isDepthZeroOrOne(analysis.depthByScc, sccIndex)) {
      subsetSccIndices.push(sccIndex);
    }
  }

  return subsetSccIndices;
}

function initializeEmptySubsetDag(
  subsetSccIndices: ReadonlyArray<number>
): Map<number, Set<number>> {
  const subsetDag = new Map<number, Set<number>>();
  for (const sccIndex of subsetSccIndices) {
    subsetDag.set(sccIndex, new Set<number>());
  }

  return subsetDag;
}

function addDepthOneToZeroSubsetEdges(
  subsetDag: ReadonlyMap<number, Set<number>>,
  subsetIndexSet: ReadonlySet<number>,
  analysis: CouplingAnalysis,
  subsetSccIndices: ReadonlyArray<number>
): void {
  for (const fromSccIndex of subsetSccIndices) {
    if (requiredDepth(analysis.depthByScc, fromSccIndex) !== 1) {
      continue;
    }

    const dependencies = analysis.dag.get(fromSccIndex);
    if (dependencies === undefined) {
      throw new Error(`Expected DAG dependencies for SCC ${String(fromSccIndex)}`);
    }

    const subsetDependencies = requiredMapGet(
      subsetDag,
      fromSccIndex,
      `depth-0/1 subset DAG node for SCC ${String(fromSccIndex)}`
    );

    for (const toSccIndex of dependencies) {
      if (!subsetIndexSet.has(toSccIndex)) {
        continue;
      }

      if (requiredDepth(analysis.depthByScc, toSccIndex) === 0) {
        subsetDependencies.add(toSccIndex);
      }
    }
  }
}

function buildDepthZeroOneSubsetGraph(
  analysis: CouplingAnalysis
): DepthZeroOneSubsetGraph {
  const subsetSccIndices = collectDepthZeroOneSccIndices(analysis);
  const subsetDag = initializeEmptySubsetDag(subsetSccIndices);
  const subsetIndexSet = new Set<number>(subsetSccIndices);

  addDepthOneToZeroSubsetEdges(
    subsetDag,
    subsetIndexSet,
    analysis,
    subsetSccIndices
  );

  return {
    dag: subsetDag,
    sccIndices: subsetSccIndices,
  };
}

function formatLeafClusteringLines(analysis: CouplingAnalysis): string[] {
  const subsetGraph = buildDepthZeroOneSubsetGraph(analysis);
  const partition = partitionLeafSccsByDistance(subsetGraph.dag);

  return [
    'Leaf clustering (max cross-cluster distance):',
    'Metric: minimum edge count between depth-0 groups, traversing edges in either direction.',
    `Cross-cluster distance sum: ${String(partition.crossClusterDistanceSum)}`,
    formatLeafClusterMembers('Cluster A', partition.clusterA, analysis),
    formatLeafClusterMembers('Cluster B', partition.clusterB, analysis),
  ];
}

function subsetUndirectedAdjacency(
  dag: ReadonlyMap<number, ReadonlySet<number>>
): Map<number, Set<number>> {
  const undirected = new Map<number, Set<number>>();

  for (const sccIndex of dag.keys()) {
    undirected.set(sccIndex, new Set<number>());
  }

  for (const [fromSccIndex, dependencies] of dag) {
    const fromNeighbors = requiredMapGet(
      undirected,
      fromSccIndex,
      `subset graph node for SCC ${String(fromSccIndex)}`
    );

    for (const toSccIndex of dependencies) {
      const toNeighbors = requiredMapGet(
        undirected,
        toSccIndex,
        `subset graph node for SCC ${String(toSccIndex)}`
      );

      fromNeighbors.add(toSccIndex);
      toNeighbors.add(fromSccIndex);
    }
  }

  return undirected;
}

function collectWeaklyConnectedComponents(
  undirected: ReadonlyMap<number, ReadonlySet<number>>,
  analysis: CouplingAnalysis
): number[][] {
  const components: number[][] = [];
  const visited = new Set<number>();

  for (const sccIndex of sortedSccIndices(undirected.keys(), analysis, 'ascending')) {
    if (visited.has(sccIndex)) {
      continue;
    }

    const queue: number[] = [sccIndex];
    const component: number[] = [];
    visited.add(sccIndex);

    let cursor = 0;
    while (cursor < queue.length) {
      const currentSccIndex = queue[cursor];
      if (currentSccIndex === undefined) {
        throw new Error('Expected SCC index while collecting weakly connected components');
      }

      cursor++;
      component.push(currentSccIndex);

      const neighbors = requiredMapGet(
        undirected,
        currentSccIndex,
        `subset neighbors for SCC ${String(currentSccIndex)}`
      );

      for (const neighborSccIndex of sortedSccIndices(neighbors, analysis, 'ascending')) {
        if (visited.has(neighborSccIndex)) {
          continue;
        }

        visited.add(neighborSccIndex);
        queue.push(neighborSccIndex);
      }
    }

    component.sort((left, right) => compareSccIndices(left, right, analysis.sccs));
    components.push(component);
  }

  components.sort((left, right) => {
    const leftLabel = left
      .flatMap((sccIndex) => {
        const sccMembers = analysis.sccs[sccIndex];
        if (sccMembers === undefined) {
          throw new Error(`Expected SCC members for SCC index ${String(sccIndex)}`);
        }

        return sccMembers;
      })
      .join(',');
    const rightLabel = right
      .flatMap((sccIndex) => {
        const sccMembers = analysis.sccs[sccIndex];
        if (sccMembers === undefined) {
          throw new Error(`Expected SCC members for SCC index ${String(sccIndex)}`);
        }

        return sccMembers;
      })
      .join(',');

    return leftLabel.localeCompare(rightLabel);
  });

  return components;
}

function formatWeaklyConnectedSubsetComponent(
  componentIndex: number,
  component: ReadonlyArray<number>,
  analysis: CouplingAnalysis
): string {
  const memberNames = component.flatMap((sccIndex) => {
    const sccMembers = analysis.sccs[sccIndex];
    if (sccMembers === undefined) {
      throw new Error(`Expected SCC members for SCC index ${String(sccIndex)}`);
    }

    return sccMembers;
  });

  return `Component ${String(componentIndex)}: ${memberNames.join(', ')}`;
}

function formatDepthZeroOneWeaklyConnectedLines(analysis: CouplingAnalysis): string[] {
  const subsetGraph = buildDepthZeroOneSubsetGraph(analysis);
  const undirected = subsetUndirectedAdjacency(subsetGraph.dag);
  const components = collectWeaklyConnectedComponents(undirected, analysis);

  const lines = ['Depth 0-1 subset weakly connected components:'];
  for (const [componentIndex, component] of components.entries()) {
    lines.push(
      formatWeaklyConnectedSubsetComponent(componentIndex + 1, component, analysis)
    );
  }

  return lines;
}

/**
 * Format SCC/depth coupling analysis as human-readable text.
 */
export function formatCouplingText(
  filePath: string,
  options: RunCouplingOptions,
  analysis: CouplingAnalysis
): string {
  const lines: string[] = [formatTextHeader(filePath, options)];

  if (analysis.sccs.length === 0) {
    lines.push('No declarations found.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('Dependents -> Dependencies:');
  lines.push(...formatNestedSccLines(analysis, analysis.dag, 'descending'));
  lines.push('');
  lines.push('Dependencies -> Dependents:');
  lines.push(...formatNestedSccLines(analysis, reverseDag(analysis.dag), 'ascending'));
  lines.push('');
  lines.push(...formatLeafClusteringLines(analysis));
  lines.push('');
  lines.push(...formatDepthZeroOneWeaklyConnectedLines(analysis));

  return `${lines.join('\n')}\n`;
}

function interpolateColor(
  from: DotColor,
  to: DotColor,
  progress: number
): DotColor {
  const clampProgress = Math.max(0, Math.min(1, progress));

  return {
    blue: Math.round(from.blue + (to.blue - from.blue) * clampProgress),
    green: Math.round(from.green + (to.green - from.green) * clampProgress),
    red: Math.round(from.red + (to.red - from.red) * clampProgress),
  };
}

function toHex(color: DotColor): string {
  return `#${color.red.toString(16).padStart(2, '0')}${color.green.toString(16).padStart(2, '0')}${color.blue.toString(16).padStart(2, '0')}`;
}

function depthColor(depth: number, maxDepth: number): string {
  const leafColor: DotColor = { red: 217, green: 249, blue: 157 };
  const deepColor: DotColor = { red: 191, green: 219, blue: 254 };

  if (maxDepth <= 0) {
    return toHex(leafColor);
  }

  return toHex(interpolateColor(leafColor, deepColor, depth / maxDepth));
}

function escapeDotLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatDotNode(
  sccIndex: number,
  sccMembers: SCC,
  depth: number,
  maxDepth: number
): string {
  const label = `SCC ${String(sccIndex + 1)}\nDepth ${String(depth)}\n${sccMembers.join('\n')}`;

  return `  scc_${String(sccIndex)} [label="${escapeDotLabel(label)}", fillcolor="${depthColor(depth, maxDepth)}"];`;
}

function formatDotEdges(dag: ReadonlyMap<number, ReadonlySet<number>>): string[] {
  const edges: string[] = [];

  for (const [fromSccIndex, dependencies] of dag) {
    for (const toSccIndex of [...dependencies].sort((left, right) => left - right)) {
      edges.push(`  scc_${String(fromSccIndex)} -> scc_${String(toSccIndex)};`);
    }
  }

  return edges;
}

function formatCouplingDotForSccIndices(
  analysis: CouplingAnalysis,
  sccIndices: ReadonlyArray<number>,
  dag: ReadonlyMap<number, ReadonlySet<number>>
): string {
  const lines: string[] = [
    'digraph Coupling {',
    '  rankdir=LR;',
    '  node [shape=box, style="filled,rounded"];',
  ];

  let maxDepth = 0;
  for (const sccIndex of sccIndices) {
    const depth = requiredDepth(analysis.depthByScc, sccIndex);
    if (depth > maxDepth) {
      maxDepth = depth;
    }
  }

  for (const sccIndex of [...sccIndices].sort((left, right) => left - right)) {
    const sccMembers = analysis.sccs[sccIndex];
    if (sccMembers === undefined) {
      throw new Error(`Expected SCC members for SCC index ${String(sccIndex)}`);
    }

    lines.push(
      formatDotNode(
        sccIndex,
        sccMembers,
        requiredDepth(analysis.depthByScc, sccIndex),
        maxDepth
      )
    );
  }

  lines.push(...formatDotEdges(dag));
  lines.push('}');

  return `${lines.join('\n')}\n`;
}

/**
 * Format SCC/depth coupling analysis as Graphviz DOT output.
 */
export function formatCouplingDot(analysis: CouplingAnalysis): string {
  return formatCouplingDotForSccIndices(
    analysis,
    [...analysis.sccs.keys()],
    analysis.dag
  );
}

/**
 * Format depth-0/1 SCC subset as Graphviz DOT output.
 */
export function formatCouplingDotDepthZeroOneSubset(
  analysis: CouplingAnalysis
): string {
  const subsetGraph = buildDepthZeroOneSubsetGraph(analysis);
  return formatCouplingDotForSccIndices(
    analysis,
    subsetGraph.sccIndices,
    subsetGraph.dag
  );
}

/**
 * Run coupling analysis and print either text or DOT output.
 */
export function runCoupling(
  filePath: string,
  options: RunCouplingOptions
): void {
  const graph =
    options.class === undefined
      ? parseModuleCoupling(filePath)
      : parseClassCoupling(filePath, options.class);

  const analysis = analyzeCouplingGraph(graph);

  const renderedOutput =
    options.graphvizDepthZeroOneSubset === true
      ? formatCouplingDotDepthZeroOneSubset(analysis)
      : options.graphviz === true
        ? formatCouplingDot(analysis)
        : formatCouplingText(filePath, options, analysis);

  if (options.output === undefined) {
    process.stdout.write(renderedOutput);
    return;
  }

  options.output.write(renderedOutput);
}
