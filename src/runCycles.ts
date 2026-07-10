import { dirname, sep } from 'path';
import { FileSystem } from './filesystem';
import { type AdjacencyMap, findSCCs, type SCC } from './graphUtils';
import { updateStorage } from './indexing';
import { DebugOptions, Obj } from './objstore';
import { denormalizePath, normalizePath } from './pathUtils';
import { findGitRepoRoot, getTypeScriptFilePaths } from './project';
import { isObjWithExporterPath, openStorage, Storage } from './storage';

export interface CyclesOptions {
  directories?: boolean;
  graphviz?: boolean;
  ascii?: boolean;
  fancy?: boolean;
  /** Working directory for path denormalization */
  cwd: string;
}

/**
 * Unicode characters for fancy terminal rendering.
 */
const UNICODE_CHARS = {
  node: '●',
  arrowLeft: '🭮',
  arrowRight: '🭬',
  horizontal: '─',
  vertical: '│',
  cornerTopLeft: '╭',
  cornerTopRight: '╮',
  cornerBottomLeft: '╰',
  cornerBottomRight: '╯',
  cross: '┼',
} as const;

/**
 * ANSI color helper — returns a function that wraps a string in escape codes.
 */
interface ColorOptions {
  fg: number;
  bold?: boolean;
}

function color(opts: ColorOptions): (s: string) => string {
  return (s: string) =>
    `\x1b[${opts.fg}m${opts.bold ? '\x1b[1m' : ''}${s}\x1b[0m`;
}

/**
 * Color scheme for fancy terminal rendering.
 */
const COLORS = {
  cycleNode: color({ fg: 31, bold: true }),
  directory: color({ fg: 34 }),
  filename: color({ fg: 37 }),
  cycleHeader: color({ fg: 36, bold: true }),
  lineConnections: color({ fg: 90 }),
};

/**
 * Terminal capability detection — captured once at the entry boundary.
 */
interface TerminalCapabilities {
  useFancy: boolean;
  terminalWidth: number;
}

interface ReportContext {
  capabilities: TerminalCapabilities;
  cwd: string;
}

function detectTerminalCapabilities(): TerminalCapabilities {
  const unicodeSupported =
    process.env.TERM !== 'dumb' &&
    process.env.LANG !== 'C' &&
    !process.env.NO_UNICODE;

  const colorSupported =
    process.env.FORCE_COLOR !== '0' &&
    (process.env.FORCE_COLOR ||
      (process.stdout.isTTY &&
        process.env.TERM !== 'dumb' &&
        (!process.env.CI || process.env.CI === 'false')));

  return {
    useFancy: Boolean(unicodeSupported && colorSupported),
    terminalWidth: process.stdout.columns || Infinity,
  };
}

/**
 * Find and report import cycles between modules or directories.
 *
 * Module cycles: Direct import cycles between TypeScript files
 * Directory cycles: Cycles between directories containing modules
 */
export async function runCycles(
  directory: string,
  options: CyclesOptions,
  debugOptions: DebugOptions,
  fresh: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
) {
  const absoluteDirectory = normalizePath(directory);
  const repoRoot = findGitRepoRoot(absoluteDirectory);
  const db = openStorage(debugOptions, {
    verbose: false,
    fresh,
    basePath: repoRoot,
    inMemory: false,
  }); // Silent for clean cycle output
  await updateStorage(repoRoot, db, false, fileSystem, writer, {});

  const capabilities = detectTerminalCapabilities();

  if (options.directories) {
    await findCycles(
      db,
      absoluteDirectory,
      options,
      fileSystem,
      buildDirectoryGraph,
      'directories',
      { capabilities, cwd: options.cwd },
    );
  } else {
    await findCycles(
      db,
      absoluteDirectory,
      options,
      fileSystem,
      buildModuleGraph,
      'modules',
      { capabilities, cwd: options.cwd },
    );
  }

  db.save();
}

async function findCycles(
  db: Storage,
  directory: string,
  options: CyclesOptions,
  fileSystem: FileSystem,
  graphBuilder: (
    db: Storage,
    filePaths: Set<string>,
  ) => ReadonlyMap<string, ReadonlySet<string>>,
  label: string,
  ctx: ReportContext,
) {
  const filePaths = await getTypeScriptFilePaths(directory, fileSystem);
  const graph = graphBuilder(db, new Set(filePaths));

  const cycles = findSCCs(graph).filter((cycle) => cycle.length > 1);

  if (options.graphviz) {
    reportCyclesGraphviz(cycles, graph, label, ctx.cwd);
  } else if (options.ascii || (options.fancy && !ctx.capabilities.useFancy)) {
    reportCyclesAscii(
      cycles,
      graph,
      label,
      ctx.cwd,
      ctx.capabilities.terminalWidth,
    );
  } else if (options.fancy && ctx.capabilities.useFancy) {
    reportCyclesFancy(
      cycles,
      graph,
      label,
      ctx.cwd,
      ctx.capabilities.terminalWidth,
    );
  } else {
    reportCycles(cycles, label, ctx.cwd);
  }
}

function getExporterPathIfInScope(
  importObj: Obj,
  filePaths: Set<string>,
): string | null {
  if (!isObjWithExporterPath(importObj)) {
    return null;
  }
  if (!filePaths.has(importObj.exporter.path)) {
    return null;
  }
  return importObj.exporter.path;
}

function addEdge(
  graph: Map<string, Set<string>>,
  from: string,
  to: string,
): void {
  let deps = graph.get(from);
  if (!deps) {
    deps = new Set();
    graph.set(from, deps);
  }
  deps.add(to);
}

function buildModuleGraph(
  db: Storage,
  filePaths: Set<string>,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const filePath of filePaths) {
    for (const importObj of db.getImportsFromFile(filePath)) {
      const exporterPath = getExporterPathIfInScope(importObj, filePaths);
      if (exporterPath) {
        addEdge(graph, filePath, exporterPath);
      }
    }
  }

  return graph;
}

function reportCycles(cycles: SCC[], label: string, cwd: string) {
  if (cycles.length === 0) {
    console.log(`No import cycles found between ${label}.`);
    return;
  }

  console.log(`Found ${cycles.length} import cycle(s) between ${label}:`);
  console.log();

  for (const [i, cycle] of cycles.entries()) {
    console.log(`Cycle ${i + 1}:`);
    for (const member of cycle) {
      console.log(`  ${denormalizePath(member, cwd)}`);
    }
    console.log();
  }
}

function reportCyclesGraphviz(
  cycles: SCC[],
  graph: AdjacencyMap,
  label: string,
  cwd: string,
) {
  if (cycles.length === 0) {
    console.log(`// No import cycles found between ${label}`);
    return;
  }

  const isDirectory = label === 'directories';
  const graphTitle = isDirectory ? 'DirectoryCycles' : 'ModuleCycles';
  const nodeShape = isDirectory
    ? 'shape=folder, style=filled, fillcolor=lightblue'
    : 'shape=box, style=rounded';
  const nodeStyle = isDirectory
    ? 'color=red, penwidth=2, fillcolor=pink'
    : 'color=red, penwidth=2';
  const sectionLabel = isDirectory ? 'Directories' : 'Nodes';

  console.log(`digraph ${graphTitle} {`);
  console.log('  rankdir=LR;');
  console.log(`  node [${nodeShape}];`);
  console.log('');

  const cycleNodes = collectCycleNodes(cycles);

  console.log(`  // ${sectionLabel}`);
  for (const node of cycleNodes) {
    const displayName = denormalizePath(node, cwd);
    const nodeId = getNodeId(node);
    console.log(`  ${nodeId} [label="${displayName}", ${nodeStyle}];`);
  }
  console.log('');

  printCycleEdges(graph, cycleNodes);
  console.log('}');
}

function collectCycleNodes(cycles: SCC[]): Set<string> {
  const nodes = new Set<string>();
  for (const cycle of cycles) {
    for (const member of cycle) {
      nodes.add(member);
    }
  }
  return nodes;
}

function printCycleEdges(graph: AdjacencyMap, cycleNodes: Set<string>): void {
  console.log('  // Edges within cycles');
  for (const node of cycleNodes) {
    const dependencies = graph.get(node);
    if (!dependencies) {
      continue;
    }
    for (const dep of dependencies) {
      if (!cycleNodes.has(dep)) {
        continue;
      }
      const fromId = getNodeId(node);
      const toId = getNodeId(dep);
      console.log(`  ${fromId} -> ${toId} [color=red, penwidth=2];`);
    }
  }
}

/**
 * Generate a valid Graphviz node identifier from a file path.
 */
function getNodeId(path: string): string {
  // Replace characters that are invalid in Graphviz identifiers
  return '"' + path.replace(/[\\/"]/g, '_').replace(/[.-]/g, '_') + '"';
}

/**
 * Truncate the middle of a path with "..." to fit within maxWidth.
 */
function truncatePathForTerminal(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) {
    return path;
  }

  // Not enough room for a meaningful prefix + "..." + suffix; hard-truncate
  if (maxWidth < 7) {
    return path.substring(0, maxWidth);
  }

  const prefixLength = Math.floor((maxWidth - 3) / 2);
  const suffixLength = maxWidth - 3 - prefixLength;
  return (
    path.substring(0, prefixLength) +
    '...' +
    path.substring(path.length - suffixLength)
  );
}

interface CycleGlyphs {
  node: string;
  horizontal: string;
  vertical: string;
  arrowLeft: string;
  arrowRight: string;
  cornerTopLeft: string;
  cornerTopRight: string;
  cornerBottomLeft: string;
  cornerBottomRight: string;
  cross: string;
  immutable: Set<string>;
}

const ASCII_GLYPHS: CycleGlyphs = {
  node: 'o',
  horizontal: '-',
  vertical: '|',
  arrowLeft: '<',
  arrowRight: '>',
  cornerTopLeft: '.',
  cornerTopRight: '.',
  cornerBottomLeft: '`',
  cornerBottomRight: '`',
  cross: '+',
  immutable: new Set(['o', '<', '>', '`', '.', '+']),
};

const FANCY_GLYPHS: CycleGlyphs = {
  node: UNICODE_CHARS.node,
  horizontal: UNICODE_CHARS.horizontal,
  vertical: UNICODE_CHARS.vertical,
  arrowLeft: UNICODE_CHARS.arrowLeft,
  arrowRight: UNICODE_CHARS.arrowRight,
  cornerTopLeft: UNICODE_CHARS.cornerTopLeft,
  cornerTopRight: UNICODE_CHARS.cornerTopRight,
  cornerBottomLeft: UNICODE_CHARS.cornerBottomLeft,
  cornerBottomRight: UNICODE_CHARS.cornerBottomRight,
  cross: UNICODE_CHARS.cross,
  immutable: new Set([
    UNICODE_CHARS.node,
    UNICODE_CHARS.arrowLeft,
    UNICODE_CHARS.arrowRight,
    UNICODE_CHARS.cornerTopLeft,
    UNICODE_CHARS.cornerTopRight,
    UNICODE_CHARS.cornerBottomLeft,
    UNICODE_CHARS.cornerBottomRight,
    UNICODE_CHARS.cross,
  ]),
};

function setGridChar(
  grid: string[][],
  row: number,
  col: number,
  char: string,
  glyphs: CycleGlyphs,
): void {
  const gridRow = grid.at(row);
  if (gridRow === undefined) {
    return;
  }
  const current = gridRow[col];
  if (current === undefined || glyphs.immutable.has(current)) {
    return;
  }
  if (
    (current === glyphs.vertical && char === glyphs.horizontal) ||
    (current === glyphs.horizontal && char === glyphs.vertical)
  ) {
    gridRow[col] = glyphs.cross;
  } else {
    gridRow[col] = char;
  }
}

function drawArrow(
  grid: string[][],
  sourcePos: [number, number],
  targetPos: [number, number],
  glyphs: CycleGlyphs,
): void {
  const [sourceRow, sourceCol] = sourcePos;
  const [targetRow, targetCol] = targetPos;
  const rowDelta = targetRow - sourceRow;
  const colDelta = targetCol - sourceCol;

  if (rowDelta === 0) {
    drawHorizontalArrow(
      grid,
      sourceRow,
      sourceCol,
      targetCol,
      colDelta,
      glyphs,
    );
    return;
  }

  drawDiagonalArrow(
    grid,
    sourceRow,
    sourceCol,
    targetRow,
    targetCol,
    rowDelta,
    glyphs,
  );
}

function drawHorizontalArrow(
  grid: string[][],
  row: number,
  sourceCol: number,
  targetCol: number,
  colDelta: number,
  glyphs: CycleGlyphs,
): void {
  const startCol = Math.min(sourceCol, targetCol) + 1;
  const endCol = Math.max(sourceCol, targetCol) - 1;
  for (let col = startCol; col <= endCol; col++) {
    setGridChar(grid, row, col, glyphs.horizontal, glyphs);
  }
  if (colDelta > 0) {
    setGridChar(grid, row, targetCol - 1, glyphs.arrowRight, glyphs);
  } else {
    setGridChar(grid, row, targetCol + 1, glyphs.arrowLeft, glyphs);
  }
}

function drawDiagonalArrow(
  grid: string[][],
  sourceRow: number,
  sourceCol: number,
  targetRow: number,
  targetCol: number,
  rowDelta: number,
  glyphs: CycleGlyphs,
): void {
  if (rowDelta > 0) {
    for (let row = sourceRow + 1; row < targetRow; row++) {
      setGridChar(grid, row, sourceCol, glyphs.vertical, glyphs);
    }
    setGridChar(grid, targetRow, sourceCol, glyphs.cornerBottomLeft, glyphs);
    for (let col = sourceCol + 1; col < targetCol; col++) {
      setGridChar(grid, targetRow, col, glyphs.horizontal, glyphs);
    }
    setGridChar(grid, targetRow, targetCol - 1, glyphs.arrowRight, glyphs);
  } else {
    for (let row = sourceRow - 1; row > targetRow; row--) {
      setGridChar(grid, row, sourceCol, glyphs.vertical, glyphs);
    }
    setGridChar(grid, targetRow, sourceCol, glyphs.cornerTopRight, glyphs);
    for (let col = sourceCol - 1; col > targetCol + 1; col--) {
      setGridChar(grid, targetRow, col, glyphs.horizontal, glyphs);
    }
    setGridChar(grid, targetRow, targetCol + 1, glyphs.arrowLeft, glyphs);
  }
}

function drawCycleArrows(
  cycle: SCC,
  graph: AdjacencyMap,
  nodePositions: Map<string, [number, number]>,
  grid: string[][],
  glyphs: CycleGlyphs,
): void {
  for (const source of cycle) {
    const dependencies = graph.get(source);
    if (!dependencies) {
      continue;
    }
    for (const target of dependencies) {
      if (!cycle.includes(target)) {
        continue;
      }
      const sourcePos = nodePositions.get(source);
      const targetPos = nodePositions.get(target);
      if (sourcePos === undefined || targetPos === undefined) {
        continue;
      }
      drawArrow(grid, sourcePos, targetPos, glyphs);
    }
  }
}

interface CycleRenderer {
  glyphs: CycleGlyphs;
  colorizeLine?: (line: string) => string;
  colorizePath?: (path: string) => string;
}

function renderCycle(
  cycle: SCC,
  graph: AdjacencyMap,
  cwd: string,
  renderer: CycleRenderer,
  terminalWidth: number,
): string[] {
  if (cycle.length === 0) {
    return [];
  }

  const nodeCount = cycle.length;
  const gridWidth = (nodeCount - 1) * 3 + 1;
  const gridHeight = (nodeCount - 1) * 2 + 1;

  const grid: string[][] = [];
  for (let row = 0; row < gridHeight; row++) {
    grid[row] = Array.from({ length: gridWidth }, () => ' ');
  }

  const nodePositions = new Map<string, [number, number]>();
  for (const [i, cycleNode] of cycle.entries()) {
    const col = i * 3;
    const row = i * 2;
    // biome-ignore lint/style/noNonNullAssertion: row = i * 2 < gridHeight = (cycle.length - 1) * 2 + 1 for i < cycle.length
    const rowCells = grid[row]!;
    rowCells[col] = renderer.glyphs.node;
    nodePositions.set(cycleNode, [row, col]);
  }

  drawCycleArrows(cycle, graph, nodePositions, grid, renderer.glyphs);
  return gridToLines(grid, cycle, cwd, renderer, terminalWidth);
}

function gridToLines(
  grid: string[][],
  cycle: SCC,
  cwd: string,
  renderer: CycleRenderer,
  terminalWidth: number,
): string[] {
  const lines: string[] = [];
  const colorizePath = renderer.colorizePath;
  const colorizeLine = renderer.colorizeLine;

  for (const [nodeIndex, cycleNode] of cycle.entries()) {
    const row = nodeIndex * 2;
    // biome-ignore lint/style/noNonNullAssertion: row = nodeIndex * 2 < gridHeight for nodeIndex < cycle.length
    const gridRow = grid[row]!;
    let line = gridRow.join('');

    const path = denormalizePath(cycleNode, cwd);
    const availableWidth = terminalWidth - line.length - 2;
    const truncatedPath = truncatePathForTerminal(path, availableWidth);
    const displayPath = colorizePath
      ? colorizePath(truncatedPath)
      : truncatedPath;
    line += '  ' + displayPath;
    lines.push(colorizeLine ? colorizeLine(line.trimEnd()) : line.trimEnd());

    if (nodeIndex < cycle.length - 1) {
      // biome-ignore lint/style/noNonNullAssertion: row + 1 < gridHeight for nodeIndex < cycle.length - 1
      const spacerRow = grid[row + 1]!;
      const spacerLine = spacerRow.join('').trimEnd();
      lines.push(colorizeLine ? colorizeLine(spacerLine) : spacerLine);
    }
  }

  return lines;
}

function renderCycleAsAscii(
  cycle: SCC,
  graph: AdjacencyMap,
  cwd: string,
  terminalWidth: number,
): string[] {
  return renderCycle(
    cycle,
    graph,
    cwd,
    { glyphs: ASCII_GLYPHS },
    terminalWidth,
  );
}

function renderCycleAsFancy(
  cycle: SCC,
  graph: AdjacencyMap,
  cwd: string,
  terminalWidth: number,
): string[] {
  return renderCycle(
    cycle,
    graph,
    cwd,
    {
      glyphs: FANCY_GLYPHS,
      colorizeLine: (line) => colorizeAsciiArt(line, FANCY_GLYPHS),
      colorizePath: colorizeFilePath,
    },
    terminalWidth,
  );
}

function colorizeFilePath(p: string): string {
  // denormalizePath uses path.relative() which produces paths with path.sep
  const lastSep = p.lastIndexOf(sep);
  if (lastSep === -1) {
    return COLORS.filename(p);
  }
  const dirPath = p.slice(0, lastSep);
  const filename = p.slice(lastSep + 1);
  const coloredDirs = dirPath
    .split(sep)
    .map((dir) => COLORS.directory(dir))
    .join(sep);
  return `${coloredDirs}${sep}${COLORS.filename(filename)}`;
}

function colorizeAsciiArt(line: string, glyphs: CycleGlyphs): string {
  let colorized = line.replaceAll(glyphs.node, COLORS.cycleNode(glyphs.node));
  for (const char of [
    glyphs.arrowLeft,
    glyphs.arrowRight,
    glyphs.horizontal,
    glyphs.vertical,
    glyphs.cornerTopLeft,
    glyphs.cornerTopRight,
    glyphs.cornerBottomLeft,
    glyphs.cornerBottomRight,
    glyphs.cross,
  ]) {
    colorized = colorized.replaceAll(char, COLORS.lineConnections(char));
  }
  return colorized;
}

function reportCyclesAscii(
  cycles: SCC[],
  graph: AdjacencyMap,
  label: string,
  cwd: string,
  terminalWidth: number,
) {
  if (cycles.length === 0) {
    console.log(`No import cycles found between ${label}.`);
    return;
  }

  console.log(`Found ${cycles.length} import cycle(s) between ${label}:`);
  console.log();

  for (const [i, cycle] of cycles.entries()) {
    const asciiLines = renderCycleAsAscii(cycle, graph, cwd, terminalWidth);
    for (const line of asciiLines) {
      console.log(line);
    }
    if (i < cycles.length - 1) {
      console.log();
    }
  }
}

function reportCyclesFancy(
  cycles: SCC[],
  graph: AdjacencyMap,
  label: string,
  cwd: string,
  terminalWidth: number,
) {
  if (cycles.length === 0) {
    console.log(`No import cycles found between ${label}.`);
    return;
  }

  console.log(
    COLORS.cycleHeader(
      `Found ${cycles.length} import cycle(s) between ${label}:`,
    ),
  );
  console.log();

  for (const [i, cycle] of cycles.entries()) {
    const fancyLines = renderCycleAsFancy(cycle, graph, cwd, terminalWidth);
    for (const line of fancyLines) {
      console.log(line);
    }
    if (i < cycles.length - 1) {
      console.log();
    }
  }
}

function buildDirectoryGraph(
  db: Storage,
  filePaths: Set<string>,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const filePath of filePaths) {
    const importerDir = dirname(filePath);
    for (const importObj of db.getImportsFromFile(filePath)) {
      const exporterPath = getExporterPathIfInScope(importObj, filePaths);
      if (!exporterPath) {
        continue;
      }
      const exporterDir = dirname(exporterPath);
      if (importerDir === exporterDir) {
        continue;
      }
      addEdge(graph, importerDir, exporterDir);
    }
  }

  return graph;
}
