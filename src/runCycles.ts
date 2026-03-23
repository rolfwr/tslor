import { updateStorage } from "./indexing.js";
import { findGitRepoRoot, getTypeScriptFilePaths } from "./project.js";
import { openStorage } from "./storage.js";
import { DebugOptions } from "./objstore.js";
import { normalizePath, denormalizePath } from "./pathUtils.js";
import { dirname } from "path";
import chalk from "chalk";
import { FileSystem } from "./filesystem.js";

export interface CyclesOptions {
  directories?: boolean;
  graphviz?: boolean;
  ascii?: boolean;
  fancy?: boolean;
}

/**
 * Unicode characters for fancy terminal rendering.
 */
const UNICODE_CHARS = {
  node: '●',
  arrowLeft: '🭮',
  arrowRight: '🭬', 
  arrowUp: '↑',
  arrowDown: '↓',
  horizontal: '─',
  vertical: '│',
  cornerTopLeft: '╭',
  cornerTopRight: '╮', 
  cornerBottomLeft: '╰',
  cornerBottomRight: '╯',
  cross: '┼'
};

/**
 * Color scheme for fancy terminal rendering.
 */
const COLORS = {
  cycleNode: chalk.red.bold,
  forwardArrow: chalk.green,
  backwardArrow: chalk.yellow,
  directory: chalk.blue,
  filename: chalk.white,
  cycleHeader: chalk.cyan.bold,
  lineConnections: chalk.gray
};

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
  fileSystem: FileSystem
) {
  const absoluteDirectory = normalizePath(directory);
  const repoRoot = findGitRepoRoot(absoluteDirectory);
  const db = openStorage(debugOptions, false); // Silent for clean cycle output
  await updateStorage(repoRoot, db, false, fileSystem);

  if (options.directories) {
    await findDirectoryCycles(db, absoluteDirectory, options);
  } else {
    await findModuleCycles(db, absoluteDirectory, options);
  }

  db.save();
}

/**
 * Find cycles between individual modules (TypeScript files).
 */
async function findModuleCycles(db: any, directory: string, options: CyclesOptions) {
  // First, discover all TypeScript files in the target directory
  const filePaths = await getTypeScriptFilePaths(directory, false);
  const fileSet = new Set(filePaths);
  
  // Build dependency graph only for files in scope
  const graph = buildModuleGraph(db, fileSet);

  // Find and report cycles
  const cycles = findStronglyConnectedComponents(graph);
  const cyclesFound = cycles.filter(cycle => cycle.length > 1);

  if (options.graphviz) {
    reportModuleCyclesGraphviz(cyclesFound, graph);
  } else if (options.fancy) {
    reportModuleCyclesFancy(cyclesFound, graph);
  } else if (options.ascii) {
    reportModuleCyclesAscii(cyclesFound, graph);
  } else {
    reportModuleCycles(cyclesFound);
  }
}

/**
 * Build dependency graph for a specific set of module files.
 */
function buildModuleGraph(db: any, filePaths: Set<string>): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  
  for (const filePath of filePaths) {
    const imports = db.getImportsFromFile(filePath);
    
    for (const importObj of imports) {
      const exporter = importObj.exporter;
      if (exporter && typeof exporter === 'object' && 'path' in exporter) {
        const exporterPath = exporter.path;
        
        // Only track dependencies to files within our scope
        if (typeof exporterPath === 'string' && filePaths.has(exporterPath)) {
          if (!graph.has(filePath)) {
            graph.set(filePath, new Set());
          }
          graph.get(filePath)!.add(exporterPath);
        }
      }
    }
  }
  
  return graph;
}

/**
 * Report module cycles in a clean format.
 */
function reportModuleCycles(cycles: string[][]) {
  if (cycles.length === 0) {
    console.log('No import cycles found between modules.');
    return;
  }

  console.log(`Found ${cycles.length} import cycle(s) between modules:`);
  console.log();

  const cwd = process.cwd();
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    console.log(`Cycle ${i + 1}:`);
    for (const module of cycle) {
      console.log(`  ${denormalizePath(module, cwd)}`);
    }
    console.log();
  }
}

/**
 * Report module cycles in Graphviz DOT format.
 */
function reportModuleCyclesGraphviz(cycles: string[][], graph: Map<string, Set<string>>) {
  if (cycles.length === 0) {
    console.log('// No import cycles found between modules');
    return;
  }

  console.log('digraph ModuleCycles {');
  console.log('  rankdir=LR;');
  console.log('  node [shape=box, style=rounded];');
  console.log('');

  const cwd = process.cwd();
  const cycleNodes = new Set<string>();
  
  // Collect all nodes that are part of cycles
  for (const cycle of cycles) {
    for (const module of cycle) {
      cycleNodes.add(module);
    }
  }
  
  // Define nodes with cycle highlighting
  console.log('  // Nodes');
  for (const node of cycleNodes) {
    const displayName = denormalizePath(node, cwd);
    const nodeId = getNodeId(node);
    console.log(`  ${nodeId} [label="${displayName}", color=red, penwidth=2];`);
  }
  console.log('');
  
  // Define edges between cycle nodes
  console.log('  // Edges within cycles');
  for (const node of cycleNodes) {
    const dependencies = graph.get(node);
    if (dependencies) {
      for (const dep of dependencies) {
        if (cycleNodes.has(dep)) {
          const fromId = getNodeId(node);
          const toId = getNodeId(dep);
          console.log(`  ${fromId} -> ${toId} [color=red, penwidth=2];`);
        }
      }
    }
  }
  
  console.log('}');
}

/**
 * Report directory cycles in Graphviz DOT format.
 */
function reportDirectoryCyclesGraphviz(cycles: string[][], graph: Map<string, Set<string>>) {
  if (cycles.length === 0) {
    console.log('// No import cycles found between directories');
    return;
  }

  console.log('digraph DirectoryCycles {');
  console.log('  rankdir=LR;');
  console.log('  node [shape=folder, style=filled, fillcolor=lightblue];');
  console.log('');

  const cwd = process.cwd();
  const cycleNodes = new Set<string>();
  
  // Collect all nodes that are part of cycles
  for (const cycle of cycles) {
    for (const dir of cycle) {
      cycleNodes.add(dir);
    }
  }
  
  // Define nodes with cycle highlighting
  console.log('  // Directories');
  for (const node of cycleNodes) {
    const displayName = denormalizePath(node, cwd);
    const nodeId = getNodeId(node);
    console.log(`  ${nodeId} [label="${displayName}", color=red, penwidth=2, fillcolor=pink];`);
  }
  console.log('');
  
  // Define edges between cycle nodes
  console.log('  // Dependencies within cycles');
  for (const node of cycleNodes) {
    const dependencies = graph.get(node);
    if (dependencies) {
      for (const dep of dependencies) {
        if (cycleNodes.has(dep)) {
          const fromId = getNodeId(node);
          const toId = getNodeId(dep);
          console.log(`  ${fromId} -> ${toId} [color=red, penwidth=2];`);
        }
      }
    }
  }
  
  console.log('}');
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
  
  if (maxWidth < 7) {
    // Not enough space for meaningful truncation
    return path.substring(0, maxWidth);
  }
  
  const prefixLength = Math.floor((maxWidth - 3) / 2);
  const suffixLength = maxWidth - 3 - prefixLength;
  
  return path.substring(0, prefixLength) + '...' + path.substring(path.length - suffixLength);
}

/**
 * Render a single cycle as ASCII art.
 */
function renderCycleAsAscii(cycle: string[], graph: Map<string, Set<string>>, cwd: string): string[] {
  if (cycle.length === 0) {
    return [];
  }
  
  // Calculate grid dimensions
  const nodeCount = cycle.length;
  const gridWidth = (nodeCount - 1) * 3 + 1; // Node positions: 0, 3, 6, 9...
  const gridHeight = (nodeCount - 1) * 2 + 1; // Node positions: 0, 2, 4, 6...
  
  // Initialize grid with spaces
  const grid: string[][] = [];
  for (let row = 0; row < gridHeight; row++) {
    grid[row] = Array.from({ length: gridWidth }, () => ' ');
  }
  
  // Place nodes at diagonal positions
  const nodePositions = new Map<string, [number, number]>();
  for (let i = 0; i < cycle.length; i++) {
    const col = i * 3;
    const row = i * 2;
    grid[row][col] = 'o';
    nodePositions.set(cycle[i], [row, col]);
  }
  
  // Draw arrows based on actual dependencies in the graph
  for (const source of cycle) {
    const dependencies = graph.get(source);
    if (dependencies) {
      for (const target of dependencies) {
        // Only draw arrows to other nodes in the same cycle
        if (cycle.includes(target)) {
          const sourcePos = nodePositions.get(source)!;
          const targetPos = nodePositions.get(target)!;
          drawArrow(grid, sourcePos, targetPos);
        }
      }
    }
  }
  
  // Convert grid to strings and add path labels
  const lines: string[] = [];
  const terminalWidth = process.stdout.columns || Infinity;
  
  for (let row = 0; row < gridHeight; row++) {
    let line = grid[row].join('');
    
    // Add path label for nodes
    const nodeIndex = Math.floor(row / 2);
    if (row % 2 === 0 && nodeIndex < cycle.length) {
      const path = denormalizePath(cycle[nodeIndex], cwd);
      const availableWidth = terminalWidth - line.length - 2; // 2 for spacing
      const truncatedPath = truncatePathForTerminal(path, availableWidth);
      line += '  ' + truncatedPath;
    }
    
    lines.push(line.trimEnd()); // Remove trailing spaces
  }
  
  return lines;
}

/**
 * Render a single cycle as fancy Unicode art with colors.
 */
function renderCycleAsFancy(cycle: string[], graph: Map<string, Set<string>>, cwd: string): string[] {
  if (cycle.length === 0) {
    return [];
  }
  
  // Calculate grid dimensions (same as ASCII version)
  const nodeCount = cycle.length;
  const gridWidth = (nodeCount - 1) * 3 + 1;
  const gridHeight = (nodeCount - 1) * 2 + 1;
  
  // Initialize grid with spaces
  const grid: string[][] = [];
  for (let row = 0; row < gridHeight; row++) {
    grid[row] = Array.from({ length: gridWidth }, () => ' ');
  }
  
  // Place nodes at diagonal positions
  const nodePositions = new Map<string, [number, number]>();
  for (let i = 0; i < cycle.length; i++) {
    const col = i * 3;
    const row = i * 2;
    grid[row][col] = UNICODE_CHARS.node;
    nodePositions.set(cycle[i], [row, col]);
  }
  
  // Draw arrows based on actual dependencies in the graph
  for (const source of cycle) {
    const dependencies = graph.get(source);
    if (dependencies) {
      for (const target of dependencies) {
        // Only draw arrows to other nodes in the same cycle
        if (cycle.includes(target)) {
          const sourcePos = nodePositions.get(source)!;
          const targetPos = nodePositions.get(target)!;
          drawFancyArrow(grid, sourcePos, targetPos);
        }
      }
    }
  }
  
  // Convert grid to strings and add colored path labels
  const lines: string[] = [];
  const terminalWidth = process.stdout.columns || Infinity;
  
  for (let row = 0; row < gridHeight; row++) {
    let line = grid[row].join('');
    
    // Add path label for nodes
    const nodeIndex = Math.floor(row / 2);
    if (row % 2 === 0 && nodeIndex < cycle.length) {
      const path = denormalizePath(cycle[nodeIndex], cwd);
      const availableWidth = terminalWidth - line.length - 2; // 2 for spacing
      const truncatedPath = truncatePathForTerminal(path, availableWidth);
      const colorizedPath = colorizeFilePath(truncatedPath);
      line += '  ' + colorizedPath;
    }
    
    // Apply colors to the ASCII art part
    line = colorizeAsciiArt(line);
    lines.push(line.trimEnd()); // Remove trailing spaces
  }
  
  return lines;
}

/**
 * Draw a fancy arrow with Unicode characters from source position to target position on the grid.
 */
function drawFancyArrow(grid: string[][], sourcePos: [number, number], targetPos: [number, number]) {
  const [sourceRow, sourceCol] = sourcePos;
  const [targetRow, targetCol] = targetPos;
  
  // Determine direction
  const rowDelta = targetRow - sourceRow;
  const colDelta = targetCol - sourceCol;
  
  if (rowDelta === 0) {
    // Horizontal line only
    const startCol = Math.min(sourceCol, targetCol) + 1;
    const endCol = Math.max(sourceCol, targetCol) - 1;
    for (let col = startCol; col <= endCol; col++) {
      setFancyGridChar(grid, sourceRow, col, UNICODE_CHARS.horizontal);
    }
    // Add arrowhead
    if (colDelta > 0) {
      setFancyGridChar(grid, targetRow, targetCol - 1, UNICODE_CHARS.arrowRight);
    } else {
      setFancyGridChar(grid, targetRow, targetCol + 1, UNICODE_CHARS.arrowLeft);
    }
  } else {
    // Vertical then horizontal movement
    if (rowDelta > 0) {
      // Moving down
      for (let row = sourceRow + 1; row < targetRow; row++) {
        setFancyGridChar(grid, row, sourceCol, UNICODE_CHARS.vertical);
      }
      setFancyGridChar(grid, targetRow, sourceCol, UNICODE_CHARS.cornerBottomLeft); // Down-right corner
      
      // Horizontal part
      for (let col = sourceCol + 1; col < targetCol; col++) {
        setFancyGridChar(grid, targetRow, col, UNICODE_CHARS.horizontal);
      }
      setFancyGridChar(grid, targetRow, targetCol - 1, UNICODE_CHARS.arrowRight);
      
    } else {
      // Moving up
      for (let row = sourceRow - 1; row > targetRow; row--) {
        setFancyGridChar(grid, row, sourceCol, UNICODE_CHARS.vertical);
      }
      setFancyGridChar(grid, targetRow, sourceCol, UNICODE_CHARS.cornerTopRight); // Up-right corner
      
      // Horizontal part - move left from source column toward target column  
      for (let col = sourceCol - 1; col > targetCol + 1; col--) {
        setFancyGridChar(grid, targetRow, col, UNICODE_CHARS.horizontal);
      }
      setFancyGridChar(grid, targetRow, targetCol + 1, UNICODE_CHARS.arrowLeft);
    }
  }
}

/**
 * Set a Unicode character on the grid, handling crossing rules.
 */
function setFancyGridChar(grid: string[][], row: number, col: number, char: string) {
  const current = grid[row][col];
  
  // Cannot overwrite these characters
  if (current === UNICODE_CHARS.node || current === UNICODE_CHARS.arrowLeft || 
      current === UNICODE_CHARS.arrowRight || current === UNICODE_CHARS.cornerTopLeft || 
      current === UNICODE_CHARS.cornerTopRight || current === UNICODE_CHARS.cornerBottomLeft || 
      current === UNICODE_CHARS.cornerBottomRight) {
    return;
  }
  
  // Handle crossing rules
  if ((current === UNICODE_CHARS.vertical && char === UNICODE_CHARS.horizontal) || 
      (current === UNICODE_CHARS.horizontal && char === UNICODE_CHARS.vertical)) {
    grid[row][col] = UNICODE_CHARS.cross;
  } else {
    grid[row][col] = char;
  }
}

/**
 * Colorize file path with syntax highlighting.
 */
function colorizeFilePath(path: string): string {
  const parts = path.split('/');
  const filename = parts[parts.length - 1];
  const directories = parts.slice(0, -1);
  
  const coloredDirs = directories.map(dir => COLORS.directory(dir)).join('/');
  const coloredFilename = COLORS.filename(filename);
  
  return directories.length > 0 ? `${coloredDirs}/${coloredFilename}` : coloredFilename;
}

/**
 * Detect terminal capabilities for Unicode and color support.
 */
function hasTerminalCapabilities(): { unicode: boolean; color: boolean } {
  // Check for color support
  const colorSupport = process.env.FORCE_COLOR !== '0' && (
    process.env.FORCE_COLOR ||
    process.stdout.isTTY && (
      process.env.TERM !== 'dumb' &&
      (!process.env.CI || process.env.CI === 'false')
    )
  );

  // Basic Unicode support detection - assume modern terminals support it
  // unless explicitly disabled
  const unicodeSupport = process.env.TERM !== 'dumb' && 
                        process.env.LANG !== 'C' &&
                        !process.env.NO_UNICODE;

  return {
    unicode: unicodeSupport,
    color: Boolean(colorSupport)
  };
}

/**
 * Apply colors to the ASCII art portion of the line.
 */
function colorizeAsciiArt(line: string): string {
  let colorized = line;
  
  // Color nodes
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.node, 'g'), COLORS.cycleNode(UNICODE_CHARS.node));
  
  // Color line connections (including arrowheads)
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.arrowLeft, 'g'), COLORS.lineConnections(UNICODE_CHARS.arrowLeft));
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.arrowRight, 'g'), COLORS.lineConnections(UNICODE_CHARS.arrowRight));
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.horizontal, 'g'), COLORS.lineConnections(UNICODE_CHARS.horizontal));
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.vertical, 'g'), COLORS.lineConnections(UNICODE_CHARS.vertical));
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.cornerTopLeft, 'g'), COLORS.lineConnections(UNICODE_CHARS.cornerTopLeft));
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.cornerTopRight, 'g'), COLORS.lineConnections(UNICODE_CHARS.cornerTopRight));
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.cornerBottomLeft, 'g'), COLORS.lineConnections(UNICODE_CHARS.cornerBottomLeft));
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.cornerBottomRight, 'g'), COLORS.lineConnections(UNICODE_CHARS.cornerBottomRight));
  colorized = colorized.replace(new RegExp(UNICODE_CHARS.cross, 'g'), COLORS.lineConnections(UNICODE_CHARS.cross));
  
  return colorized;
}

/**
 * Draw an arrow from source position to target position on the grid.
 */
function drawArrow(grid: string[][], sourcePos: [number, number], targetPos: [number, number]) {
  const [sourceRow, sourceCol] = sourcePos;
  const [targetRow, targetCol] = targetPos;
  
  // Determine direction
  const rowDelta = targetRow - sourceRow;
  const colDelta = targetCol - sourceCol;
  
  if (rowDelta === 0) {
    // Horizontal line only
    const startCol = Math.min(sourceCol, targetCol) + 1;
    const endCol = Math.max(sourceCol, targetCol) - 1;
    for (let col = startCol; col <= endCol; col++) {
      setGridChar(grid, sourceRow, col, '-');
    }
    // Add arrowhead
    if (colDelta > 0) {
      setGridChar(grid, targetRow, targetCol - 1, '>');
    } else {
      setGridChar(grid, targetRow, targetCol + 1, '<');
    }
  } else {
    // Vertical then horizontal movement
    if (rowDelta > 0) {
      // Moving down
      for (let row = sourceRow + 1; row < targetRow; row++) {
        setGridChar(grid, row, sourceCol, '|');
      }
      setGridChar(grid, targetRow, sourceCol, '`'); // Down-right corner
      
      // Horizontal part
      for (let col = sourceCol + 1; col < targetCol; col++) {
        setGridChar(grid, targetRow, col, '-');
      }
      setGridChar(grid, targetRow, targetCol - 1, '>');
      
    } else {
      // Moving up
      for (let row = sourceRow - 1; row > targetRow; row--) {
        setGridChar(grid, row, sourceCol, '|');
      }
      setGridChar(grid, targetRow, sourceCol, '.'); // Up-right corner
      
      // Horizontal part - move left from source column toward target column  
      for (let col = sourceCol - 1; col > targetCol + 1; col--) {
        setGridChar(grid, targetRow, col, '-');
      }
      setGridChar(grid, targetRow, targetCol + 1, '<');
    }
  }
}

/**
 * Set a character on the grid, handling crossing rules.
 */
function setGridChar(grid: string[][], row: number, col: number, char: string) {
  const current = grid[row][col];
  
  // Cannot overwrite these characters
  if (current === 'o' || current === '<' || current === '>' || current === '`' || current === '.') {
    return;
  }
  
  // Handle crossing rules
  if ((current === '|' && char === '-') || (current === '-' && char === '|')) {
    grid[row][col] = '+';
  } else {
    grid[row][col] = char;
  }
}

/**
 * Report module cycles in ASCII art format.
 */
function reportModuleCyclesAscii(cycles: string[][], graph: Map<string, Set<string>>) {
  if (cycles.length === 0) {
    console.log('No import cycles found between modules.');
    return;
  }

  console.log(`Found ${cycles.length} import cycle(s) between modules:`);
  console.log();

  const cwd = process.cwd();
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    const asciiLines = renderCycleAsAscii(cycle, graph, cwd);
    
    for (const line of asciiLines) {
      console.log(line);
    }
    
    // Add empty line between cycles (except after the last one)
    if (i < cycles.length - 1) {
      console.log();
    }
  }
}

/**
 * Report module cycles in fancy Unicode art format with colors.
 */
function reportModuleCyclesFancy(cycles: string[][], graph: Map<string, Set<string>>) {
  if (cycles.length === 0) {
    console.log('No import cycles found between modules.');
    return;
  }

  const capabilities = hasTerminalCapabilities();
  
  // Fallback to ASCII if Unicode not supported
  if (!capabilities.unicode) {
    console.log('Unicode not supported, falling back to ASCII rendering...');
    reportModuleCyclesAscii(cycles, graph);
    return;
  }

  console.log(COLORS.cycleHeader(`Found ${cycles.length} import cycle(s) between modules:`));
  console.log();

  const cwd = process.cwd();
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    const fancyLines = renderCycleAsFancy(cycle, graph, cwd);
    
    for (const line of fancyLines) {
      console.log(line);
    }
    
    // Add empty line between cycles (except after the last one)
    if (i < cycles.length - 1) {
      console.log();
    }
  }
}

/**
 * Report directory cycles in ASCII art format.
 */
function reportDirectoryCyclesAscii(cycles: string[][], graph: Map<string, Set<string>>) {
  if (cycles.length === 0) {
    console.log('No import cycles found between directories.');
    return;
  }

  console.log(`Found ${cycles.length} import cycle(s) between directories:`);
  console.log();

  const cwd = process.cwd();
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    const asciiLines = renderCycleAsAscii(cycle, graph, cwd);
    
    for (const line of asciiLines) {
      console.log(line);
    }
    
    // Add empty line between cycles (except after the last one)
    if (i < cycles.length - 1) {
      console.log();
    }
  }
}

/**
 * Report directory cycles in fancy Unicode art format with colors.
 */
function reportDirectoryCyclesFancy(cycles: string[][], graph: Map<string, Set<string>>) {
  if (cycles.length === 0) {
    console.log('No import cycles found between directories.');
    return;
  }

  const capabilities = hasTerminalCapabilities();
  
  // Fallback to ASCII if Unicode not supported
  if (!capabilities.unicode) {
    console.log('Unicode not supported, falling back to ASCII rendering...');
    reportDirectoryCyclesAscii(cycles, graph);
    return;
  }

  console.log(COLORS.cycleHeader(`Found ${cycles.length} import cycle(s) between directories:`));
  console.log();

  const cwd = process.cwd();
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    const fancyLines = renderCycleAsFancy(cycle, graph, cwd);
    
    for (const line of fancyLines) {
      console.log(line);
    }
    
    // Add empty line between cycles (except after the last one)
    if (i < cycles.length - 1) {
      console.log();
    }
  }
}

/**
 * Find cycles between directories containing modules.
 */
async function findDirectoryCycles(db: any, directory: string, options: CyclesOptions) {
  // First, discover all TypeScript files in the target directory
  const filePaths = await getTypeScriptFilePaths(directory, false);
  const fileSet = new Set(filePaths);
  
  // Build directory-level dependency graph
  const dirGraph = buildDirectoryGraph(db, fileSet);

  // Find and report cycles
  const cycles = findStronglyConnectedComponents(dirGraph);
  const cyclesFound = cycles.filter(cycle => cycle.length > 1);

  if (options.graphviz) {
    reportDirectoryCyclesGraphviz(cyclesFound, dirGraph);
  } else if (options.fancy) {
    reportDirectoryCyclesFancy(cyclesFound, dirGraph);
  } else if (options.ascii) {
    reportDirectoryCyclesAscii(cyclesFound, dirGraph);
  } else {
    reportDirectoryCycles(cyclesFound);
  }
}

/**
 * Build directory dependency graph for a specific set of module files.
 */
function buildDirectoryGraph(db: any, filePaths: Set<string>): Map<string, Set<string>> {
  const dirGraph = new Map<string, Set<string>>();
  
  for (const filePath of filePaths) {
    const imports = db.getImportsFromFile(filePath);
    const importerDir = dirname(filePath);
    
    for (const importObj of imports) {
      const exporter = importObj.exporter;
      if (exporter && typeof exporter === 'object' && 'path' in exporter) {
        const exporterPath = exporter.path;
        
        if (typeof exporterPath === 'string' && filePaths.has(exporterPath)) {
          const exporterDir = dirname(exporterPath);
          
          // Only track cross-directory dependencies
          if (importerDir !== exporterDir) {
            if (!dirGraph.has(importerDir)) {
              dirGraph.set(importerDir, new Set());
            }
            dirGraph.get(importerDir)!.add(exporterDir);
          }
        }
      }
    }
  }
  
  return dirGraph;
}

/**
 * Report directory cycles in a clean format.
 */
function reportDirectoryCycles(cycles: string[][]) {
  if (cycles.length === 0) {
    console.log('No import cycles found between directories.');
    return;
  }

  console.log(`Found ${cycles.length} import cycle(s) between directories:`);
  console.log();

  const cwd = process.cwd();
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    console.log(`Cycle ${i + 1}:`);
    for (const dir of cycle) {
      console.log(`  ${denormalizePath(dir, cwd)}`);
    }
    console.log();
  }
}

/**
 * Tarjan's algorithm for finding strongly connected components (cycles).
 */
function findStronglyConnectedComponents<T>(graph: Map<T, Set<T>>): T[][] {
  const index = new Map<T, number>();
  const lowlink = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const components: T[][] = [];
  let indexCounter = 0;

  function strongConnect(v: T) {
    index.set(v, indexCounter);
    lowlink.set(v, indexCounter);
    indexCounter++;
    stack.push(v);
    onStack.add(v);

    const neighbors = graph.get(v) || new Set();
    for (const w of neighbors) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: T[] = [];
      let w: T;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const v of graph.keys()) {
    if (!index.has(v)) {
      strongConnect(v);
    }
  }

  return components;
}

