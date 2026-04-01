import { findGitRepoRoot, getTypeScriptFilePaths } from './project';
import { Storage, openStorage } from './storage';
import { updateStorage } from './indexing';
import { DebugOptions } from './objstore';
import { normalizePath, denormalizePath } from './pathUtils';
import { FileSystem } from './filesystem';

interface HotModuleInfo {
  path: string;
  imports: string[];
  importedBy: string[];
  upward: Score | null;
  downward: Score | null;
  badness: number | null;
}

interface Score {
  weight: number;
  sum: number;
}

interface Direction {
  getScore(hotModule: HotModuleInfo): Score | null;
  setScore(hotModule: HotModuleInfo, score: Score): void;
  getRelations(hotModule: HotModuleInfo): string[];
  getInverseRelations(hotModule: HotModuleInfo): string[];
}

interface Options {
  select: string | null;
}

const cycleCost = 100;
const internalWeight = 0.1;

const upwardsDir: Direction = {
  getScore: (hotModule) => hotModule.upward,
  setScore: (hotModule, score) => (hotModule.upward = score),
  getRelations: (hotModule) => hotModule.importedBy,
  getInverseRelations: (hotModule) => hotModule.imports,
};

const downwardsDir: Direction = {
  getScore: (hotModule) => hotModule.downward,
  setScore: (hotModule, score) => (hotModule.downward = score),
  getRelations: (hotModule) => hotModule.imports,
  getInverseRelations: (hotModule) => hotModule.importedBy,
};

function getHotModule(hotMods: Record<string, HotModuleInfo>, modulePath: string): HotModuleInfo {
  let moduleInfo = hotMods[modulePath];
  if (!moduleInfo) {
    moduleInfo = {
      path: modulePath,
      imports: [],
      importedBy: [],
      upward: null,
      downward: null,
      badness: null,
    };
    hotMods[modulePath] = moduleInfo;
  }
  return moduleInfo;
}

function calcDirection(
  hotMods: Record<string, HotModuleInfo>,
  hotModule: HotModuleInfo,
  seen: Set<string>,
  direction: Direction
): void {
  const existing = direction.getScore(hotModule);
  if (existing !== null) {
    return;
  }

  const relations = direction.getRelations(hotModule);
  if (relations.length === 0) {
    direction.setScore(hotModule, { weight: 1, sum: 1 });
    return;
  }

  if (seen.has(hotModule.path)) {
    direction.setScore(hotModule, { weight: cycleCost, sum: cycleCost });
    return;
  }

  seen.add(hotModule.path);

  const score: Score = { weight: 0, sum: 0 };
  for (const relation of relations) {
    const hotRelation = hotMods[relation];
    if (!hotRelation) {
      throw new Error('No hot module for ' + relation);
    }
    calcDirection(hotMods, hotRelation, seen, direction);
    const hotRelationScore = direction.getScore(hotRelation);
    if (!hotRelationScore) {
      throw new Error('No score for ' + relation);
    }
    const inverseRelations = direction.getInverseRelations(hotRelation);
    score.weight += hotRelationScore.weight / inverseRelations.length + internalWeight;
    score.sum += hotRelationScore.sum + internalWeight;
  }

  direction.setScore(hotModule, score);
}

function calcUpwards(
  hotMods: Record<string, HotModuleInfo>,
  hotModule: HotModuleInfo,
  seen: Set<string>
): void {
  calcDirection(hotMods, hotModule, seen, upwardsDir);
}

function calcDownwards(
  hotMods: Record<string, HotModuleInfo>,
  hotModule: HotModuleInfo,
  seen: Set<string>
): void {
  calcDirection(hotMods, hotModule, seen, downwardsDir);
}

interface Color {
  red: number;
  green: number;
  blue: number;
}

const coolColor: Color = {
  red: 0,
  green: 0,
  blue: 0,
};

const warmColor: Color = {
  red: 159,
  green: 31,
  blue: 31,
};

const hotColor: Color = {
  red: 255,
  green: 255,
  blue: 95,
};

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpColor(a: Color, b: Color, t: number): Color {
  return {
    red: lerp(a.red, b.red, t),
    green: lerp(a.green, b.green, t),
    blue: lerp(a.blue, b.blue, t),
  };
}

function hotnessColor(hotness: number, leastHot: number, medianHot: number, mostHot: number): Color {
  if (medianHot === leastHot && mostHot === medianHot) {
    return coolColor;
  }
  if (hotness < medianHot) {
    const range = medianHot - leastHot;
    return range === 0 ? coolColor : lerpColor(coolColor, warmColor, (hotness - leastHot) / range);
  }

  const range = mostHot - medianHot;
  return range === 0 ? warmColor : lerpColor(warmColor, hotColor, (hotness - medianHot) / range);
}

function buildHotModuleGraph(db: Storage, filePaths: string[]): Record<string, HotModuleInfo> {
  const hotMods: Record<string, HotModuleInfo> = {};
  const fileSet = new Set(filePaths);

  // Build the graph only for files in scope
  for (const modulePath of filePaths) {
    const hotModule = getHotModule(hotMods, modulePath);
    
    // Get all imports for this module
    const exporterPaths = db.getExporterPathsOfImport(modulePath);
    const imports = new Set<string>();
    
    for (const exporter of exporterPaths) {
      // Only include imports that are within our scoped files
      if (fileSet.has(exporter.path)) {
        imports.add(exporter.path);
      }
    }
    
    hotModule.imports = Array.from(imports);
    
    // Build reverse relationship
    for (const importPath of hotModule.imports) {
      const importedModule = getHotModule(hotMods, importPath);
      importedModule.importedBy.push(modulePath);
    }
  }

  return hotMods;
}

export async function runHot(directory: string, options: Options, debugOptions: DebugOptions, fileSystem: FileSystem): Promise<void> {
  // Normalize directory path (follows cycles command pattern)
  const absoluteDir = normalizePath(directory);
  const repoRoot = findGitRepoRoot(absoluteDir);
  const cwd = process.cwd();

  // Load or build the index
  const db = openStorage(debugOptions, false);
  await updateStorage(repoRoot, db, true, fileSystem, absoluteDir);

  // Get all TypeScript files in the target directory (follows cycles command pattern)
  const filePaths = await getTypeScriptFilePaths(absoluteDir, false);
  
  if (filePaths.length === 0) {
    console.log('No TypeScript files found in directory.');
    return;
  }

  // Build the hot module graph
  const hotMods = buildHotModuleGraph(db, filePaths);

  // Calculate scores for all modules
  for (const modulePath in hotMods) {
    const hotModule = hotMods[modulePath];
    calcUpwards(hotMods, hotModule, new Set());
    calcDownwards(hotMods, hotModule, new Set());
    hotModule.badness = (hotModule.upward!.weight - 1) * (hotModule.downward!.weight - 1);
  }

  // Sort by badness
  const hotArray = Object.values(hotMods);
  hotArray.sort((a, b) => b.badness! - a.badness!);

  // Select module to analyze
  let selected: HotModuleInfo | null = null;
  if (options.select) {
    selected = hotMods[options.select];
    if (!selected) {
      throw new Error('Module not found in analyzed directory: ' + options.select);
    }
  } else {
    selected = hotArray[0];
  }

  if (!selected) {
    console.log('No modules found to analyze.');
    return;
  }

  // Print top 10 hottest modules
  console.log();
  console.log('Top 10 hottest modules:');
  for (let i = 0; i < 10 && i < hotArray.length; i++) {
    const hotModule = hotArray[i];
    console.log(String(Math.round(hotModule.badness!)).padStart(10), denormalizePath(hotModule.path, cwd));
  }
  console.log();

  // Build the hot chain
  const importedByChain: HotModuleInfo[] = [];
  const seen = new Set<string>();

  let current = selected;
  while (true) {
    let hottestImporter: HotModuleInfo | null = null;
    let score = Number.NEGATIVE_INFINITY;
    for (const importedBy of current.importedBy) {
      const hotImporter = hotMods[importedBy];
      if (!hotImporter) {
        throw new Error('No hot module for ' + importedBy);
      }
      if (seen.has(importedBy)) {
        continue;
      }
      if (hotImporter.upward!.sum > score) {
        hottestImporter = hotImporter;
        score = hotImporter.upward!.sum;
      }
    }
    if (!hottestImporter) {
      break;
    }

    importedByChain.push(hottestImporter);
    seen.add(hottestImporter.path);

    current = hottestImporter;
  }

  current = selected;
  const importChain: HotModuleInfo[] = [];

  seen.clear();
  while (true) {
    let hottestImport: HotModuleInfo | null = null;
    let score = Number.NEGATIVE_INFINITY;
    for (const imported of current.imports) {
      const hotImport = hotMods[imported];
      if (!hotImport) {
        throw new Error('No hot module for ' + imported);
      }
      if (seen.has(imported)) {
        continue;
      }

      if (hotImport.downward!.sum > score) {
        hottestImport = hotImport;
        score = hotImport.downward!.sum;
      }
    }

    if (!hottestImport) {
      break;
    }

    importChain.push(hottestImport);
    seen.add(hottestImport.path);

    current = hottestImport;
  }

  const hotChain = [...importedByChain.reverse(), selected, ...importChain];

  const badnessArr = hotChain.map((hotModule) => hotModule.badness!);
  badnessArr.sort((a, b) => a - b);
  const leastHot = badnessArr[0];
  const medianHot = badnessArr[Math.floor(badnessArr.length / 2)];
  const mostHot = badnessArr[badnessArr.length - 1];

  console.log('Hot import chain:');
  for (const hotModule of hotChain) {
    const dim = '\x1b[2m';
    const bright = '\x1b[1m';
    const selectColor = hotModule === selected ? bright : dim;
    const reset = '\x1b[0m';
    const up = hotModule.importedBy.length;
    const down = hotModule.imports.length;
    const arrowUp = up > 0 ? up + '↑' : '';
    const arrowDown = down > 0 ? down + '↓' : '';

    const prefix = arrowUp.padStart(6) + arrowDown.padStart(6);
    const rgb = hotnessColor(hotModule.badness!, leastHot, medianHot, mostHot);

    console.log(
      dim +
        prefix +
        '  \x1b[48;2;' +
        rgb.red +
        ';' +
        rgb.green +
        ';' +
        rgb.blue +
        'm ' +
        reset +
        '  ' +
        selectColor +
        denormalizePath(hotModule.path, cwd) +
        reset
    );
  }
  console.log();
  
  db.save();
}
