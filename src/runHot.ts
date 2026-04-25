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

/* After calculateAllScores, badness is guaranteed to be a number. */
interface ScoredHotModuleInfo extends HotModuleInfo {
  badness: number;
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
): Score {
  const existing = direction.getScore(hotModule);
  if (existing !== null) {
    return existing;
  }

  const relations = direction.getRelations(hotModule);
  if (relations.length === 0) {
    const score: Score = { weight: 1, sum: 1 };
    direction.setScore(hotModule, score);
    return score;
  }

  if (seen.has(hotModule.path)) {
    const score: Score = { weight: cycleCost, sum: cycleCost };
    direction.setScore(hotModule, score);
    return score;
  }

  seen.add(hotModule.path);

  const score: Score = { weight: 0, sum: 0 };
  for (const relation of relations) {
    const hotRelation = hotMods[relation];
    if (!hotRelation) {
      throw new Error('No hot module for ' + relation);
    }
    const hotRelationScore = calcDirection(hotMods, hotRelation, seen, direction);
    const inverseRelations = direction.getInverseRelations(hotRelation);
    score.weight += hotRelationScore.weight / inverseRelations.length + internalWeight;
    score.sum += hotRelationScore.sum + internalWeight;
  }

  direction.setScore(hotModule, score);
  return score;
}

function calcUpwards(
  hotMods: Record<string, HotModuleInfo>,
  hotModule: HotModuleInfo,
  seen: Set<string>
): Score {
  return calcDirection(hotMods, hotModule, seen, upwardsDir);
}

function calcDownwards(
  hotMods: Record<string, HotModuleInfo>,
  hotModule: HotModuleInfo,
  seen: Set<string>
): Score {
  return calcDirection(hotMods, hotModule, seen, downwardsDir);
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

export function buildHotModuleGraph(db: Storage, filePaths: string[]): Record<string, HotModuleInfo> {
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

export function calculateAllScores(
  hotMods: Record<string, HotModuleInfo>
): Record<string, ScoredHotModuleInfo> {
  for (const hotModule of Object.values(hotMods)) {
    const upward = calcUpwards(hotMods, hotModule, new Set());
    const downward = calcDownwards(hotMods, hotModule, new Set());
    hotModule.badness = (upward.weight - 1) * (downward.weight - 1);
  }
  return hotMods as Record<string, ScoredHotModuleInfo>;
}

export function selectHotModule(
  hotMods: Record<string, ScoredHotModuleInfo>,
  hotArray: ScoredHotModuleInfo[],
  options: Options
): ScoredHotModuleInfo {
  if (options.select) {
    const found = hotMods[options.select];
    if (!found) {
      throw new Error('Module not found in analyzed directory: ' + options.select);
    }
    return found;
  }
  const first = hotArray.at(0);
  if (first === undefined) {
    throw new Error('No modules in hot array');
  }
  return first;
}

function printTopModules(hotArray: ScoredHotModuleInfo[], cwd: string): void {
  console.log();
  console.log('Top 10 hottest modules:');
  for (let i = 0; i < 10 && i < hotArray.length; i++) {
    const hotModule = hotArray.at(i);
    if (hotModule === undefined) {
      continue;
    }
    console.log(String(Math.round(hotModule.badness)).padStart(10), denormalizePath(hotModule.path, cwd));
  }
  console.log();
}

export function buildImportedByChain(
  hotMods: Record<string, ScoredHotModuleInfo>,
  selected: HotModuleInfo
): ScoredHotModuleInfo[] {
  const chain: ScoredHotModuleInfo[] = [];
  const seen = new Set<string>([selected.path]);
  let current = selected;
  while (true) {
    let best: ScoredHotModuleInfo | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const importedBy of current.importedBy) {
      const hotImporter = hotMods[importedBy];
      if (!hotImporter) {
        throw new Error('No hot module for ' + importedBy);
      }
      const upward = hotImporter.upward;
      if (upward === null) {
        continue;
      }
      if (!seen.has(importedBy) && upward.sum > bestScore) {
        best = hotImporter;
        bestScore = upward.sum;
      }
    }
    if (!best) {
      break;
    }
    chain.push(best);
    seen.add(best.path);
    current = best;
  }
  return chain;
}

export function buildImportChain(
  hotMods: Record<string, ScoredHotModuleInfo>,
  selected: HotModuleInfo
): ScoredHotModuleInfo[] {
  const chain: ScoredHotModuleInfo[] = [];
  const seen = new Set<string>([selected.path]);
  let current = selected;
  while (true) {
    let best: ScoredHotModuleInfo | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const imported of current.imports) {
      const hotImport = hotMods[imported];
      if (!hotImport) {
        throw new Error('No hot module for ' + imported);
      }
      const downward = hotImport.downward;
      if (downward === null) {
        continue;
      }
      if (!seen.has(imported) && downward.sum > bestScore) {
        best = hotImport;
        bestScore = downward.sum;
      }
    }
    if (!best) {
      break;
    }
    chain.push(best);
    seen.add(best.path);
    current = best;
  }
  return chain;
}

function printHotChain(hotChain: ScoredHotModuleInfo[], selected: HotModuleInfo, cwd: string): void {
  const badnessArr = hotChain.map((m) => m.badness).sort((a, b) => a - b);
  const len = badnessArr.length;
  if (len === 0) {
    return;
  }
  const leastHot = badnessArr.at(0);
  const medianHot = badnessArr.at(Math.floor(len / 2));
  const mostHot = badnessArr.at(-1);
  if (leastHot === undefined || medianHot === undefined || mostHot === undefined) {
    return;
  }

  console.log('Hot import chain:');
  for (const hotModule of hotChain) {
    const dim = '\x1b[2m';
    const bright = '\x1b[1m';
    const selectColor = hotModule === selected ? bright : dim;
    const reset = '\x1b[0m';
    const up = hotModule.importedBy.length;
    const down = hotModule.imports.length;
    const arrowUp = up > 0 ? up + '\u2191' : '';
    const arrowDown = down > 0 ? down + '\u2193' : '';
    const prefix = arrowUp.padStart(6) + arrowDown.padStart(6);
    const rgb = hotnessColor(hotModule.badness, leastHot, medianHot, mostHot);
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
}

export async function runHot(directory: string, options: Options, debugOptions: DebugOptions, fileSystem: FileSystem): Promise<void> {
  const absoluteDir = normalizePath(directory);
  const repoRoot = findGitRepoRoot(absoluteDir);
  const cwd = process.cwd();

  const db = openStorage(debugOptions, false);
  await updateStorage(repoRoot, db, true, fileSystem, absoluteDir);

  const filePaths = await getTypeScriptFilePaths(absoluteDir, false);
  if (filePaths.length === 0) {
    console.log('No TypeScript files found in directory.');
    return;
  }

  const hotMods = buildHotModuleGraph(db, filePaths);
  const scoredMods = calculateAllScores(hotMods);

  const hotArray = Object.values(scoredMods);
  hotArray.sort((a, b) => b.badness - a.badness);

  const selected = selectHotModule(scoredMods, hotArray, options);

  printTopModules(hotArray, cwd);

  const importedByChain = buildImportedByChain(scoredMods, selected);
  const importChain = buildImportChain(scoredMods, selected);
  const hotChain = [...importedByChain.reverse(), selected, ...importChain];

  printHotChain(hotChain, selected, cwd);
  db.save();
}
