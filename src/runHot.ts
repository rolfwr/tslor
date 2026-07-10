import { invariant } from './invariant';
import { CliError } from './errors';
import { findGitRepoRoot, getTsconfigPathForFile } from './project';
import { ExporterPath, Storage, openStorage } from './storage';
import { updateStorage } from './indexing';
import { DebugOptions } from './objstore';
import { normalizePath, denormalizePath } from './pathUtils';
import { resolveCommandScope } from './commandScope';
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

/**
 * Options shared by pure helper functions (selectHotModule).
 * Does not include I/O-related fields.
 */
export interface HotSelectOptions {
  /** Module path to analyze instead of the hottest module */
  select: string | null;
}

/**
 * Full options for the runHot command.
 */
export interface Options extends HotSelectOptions {
  /** Only consider imports within the same tsconfig project (default: false) */
  projectScope?: boolean;
  /** When true, delete the existing index database before opening storage */
  fresh?: boolean;
  /**
   * Callback for indexing progress messages. Tests can supply a stub to
   * suppress output.
   */
  writer: (message: string) => void;
  /** Whether to use ANSI color codes in output */
  color: boolean;
  /** Working directory for path denormalization */
  cwd: string;
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

function getHotModule(
  hotMods: Record<string, HotModuleInfo>,
  modulePath: string,
): HotModuleInfo {
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
  direction: Direction,
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
    invariant(hotRelation, 'No hot module for ' + relation);
    const hotRelationScore = calcDirection(
      hotMods,
      hotRelation,
      seen,
      direction,
    );
    const inverseRelations = direction.getInverseRelations(hotRelation);
    score.weight +=
      hotRelationScore.weight / inverseRelations.length + internalWeight;
    score.sum += hotRelationScore.sum + internalWeight;
  }

  direction.setScore(hotModule, score);
  return score;
}

function calcUpwards(
  hotMods: Record<string, HotModuleInfo>,
  hotModule: HotModuleInfo,
  seen: Set<string>,
): Score {
  return calcDirection(hotMods, hotModule, seen, upwardsDir);
}

function calcDownwards(
  hotMods: Record<string, HotModuleInfo>,
  hotModule: HotModuleInfo,
  seen: Set<string>,
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

function hotnessColor(
  hotness: number,
  leastHot: number,
  medianHot: number,
  mostHot: number,
): Color {
  if (medianHot === leastHot && mostHot === medianHot) {
    return coolColor;
  }
  if (hotness < medianHot) {
    const range = medianHot - leastHot;
    return range === 0
      ? coolColor
      : lerpColor(coolColor, warmColor, (hotness - leastHot) / range);
  }

  const range = mostHot - medianHot;
  return range === 0
    ? warmColor
    : lerpColor(warmColor, hotColor, (hotness - medianHot) / range);
}

function isExportInScope(
  exporter: ExporterPath,
  importerPath: string,
  fileSet: Set<string>,
  moduleTsconfigMap: Map<string, string> | undefined,
): boolean {
  if (!fileSet.has(exporter.path)) {
    return false;
  }
  if (moduleTsconfigMap !== undefined) {
    const importerTsconfig = moduleTsconfigMap.get(importerPath);
    if (
      importerTsconfig !== undefined &&
      importerTsconfig !== exporter.tsconfig
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Build an import graph for the given files, querying the index for each file's
 * dependencies.
 *
 * @param db - Storage index to query for import relationships
 * @param filePaths - Absolute paths of modules to include in the graph
 * @param moduleTsconfigMap - Optional map from module path to tsconfig path.
 *     When provided, imports crossing tsconfig boundaries are filtered out
 *     on a per-importer basis.
 * @returns Graph keyed by normalized module path
 */
export function buildHotModuleGraph(
  db: Storage,
  filePaths: string[],
  moduleTsconfigMap: Map<string, string> | undefined,
): Record<string, HotModuleInfo> {
  const hotMods: Record<string, HotModuleInfo> = {};
  const fileSet = new Set(filePaths);

  for (const modulePath of filePaths) {
    const hotModule = getHotModule(hotMods, modulePath);
    const exporterPaths = db.getExporterPathsOfImport(modulePath);

    hotModule.imports = exporterPaths
      .filter((exporter) =>
        isExportInScope(exporter, modulePath, fileSet, moduleTsconfigMap),
      )
      .map((exporter) => exporter.path);

    for (const importPath of hotModule.imports) {
      const importedModule = getHotModule(hotMods, importPath);
      importedModule.importedBy.push(modulePath);
    }
  }

  return hotMods;
}

export function calculateAllScores(
  hotMods: Record<string, HotModuleInfo>,
): Record<string, ScoredHotModuleInfo> {
  const scored: Record<string, ScoredHotModuleInfo> = {};
  for (const [path, hotModule] of Object.entries(hotMods)) {
    const upward = calcUpwards(hotMods, hotModule, new Set());
    const downward = calcDownwards(hotMods, hotModule, new Set());
    scored[path] = {
      ...hotModule,
      badness: (upward.weight - 1) * (downward.weight - 1),
    };
  }
  return scored;
}

export function selectHotModule(
  hotMods: Record<string, ScoredHotModuleInfo>,
  hotArray: ScoredHotModuleInfo[],
  options: HotSelectOptions,
): ScoredHotModuleInfo {
  if (options.select) {
    const normalizedSelect = normalizePath(options.select);
    const found = hotMods[normalizedSelect];
    if (!found) {
      throw new CliError(
        'Module not found in analyzed paths: ' + options.select,
        {},
      );
    }
    return found;
  }
  const first = hotArray.at(0);
  invariant(first !== undefined, 'No modules in hot array');
  return first;
}

function printTopModules(
  hotArray: ScoredHotModuleInfo[],
  cwd: string,
  writer: (message: string) => void,
): void {
  writer('\n');
  writer('Top 10 hottest modules:\n');
  for (const hotModule of hotArray.slice(0, 10)) {
    writer(
      String(Math.round(hotModule.badness)).padStart(10) +
        ' ' +
        denormalizePath(hotModule.path, cwd) +
        '\n',
    );
  }
  writer('\n');
}

export function buildImportedByChain(
  hotMods: Record<string, ScoredHotModuleInfo>,
  selected: HotModuleInfo,
): ScoredHotModuleInfo[] {
  const chain: ScoredHotModuleInfo[] = [];
  const seen = new Set<string>([selected.path]);
  let current = selected;
  while (true) {
    let best: ScoredHotModuleInfo | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const importedBy of current.importedBy) {
      const hotImporter = hotMods[importedBy];
      invariant(hotImporter, 'No hot module for ' + importedBy);
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
  selected: HotModuleInfo,
): ScoredHotModuleInfo[] {
  const chain: ScoredHotModuleInfo[] = [];
  const seen = new Set<string>([selected.path]);
  let current = selected;
  while (true) {
    let best: ScoredHotModuleInfo | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const imported of current.imports) {
      const hotImport = hotMods[imported];
      invariant(hotImport, 'No hot module for ' + imported);
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

export interface PrintHotChainOptions {
  useColor: boolean;
  writer: (message: string) => void;
}

export function printHotChain(
  hotChain: ScoredHotModuleInfo[],
  selected: HotModuleInfo,
  cwd: string,
  options: PrintHotChainOptions,
): void {
  const { writer, useColor } = options;
  const badnessArr = hotChain.map((m) => m.badness).sort((a, b) => a - b);
  const len = badnessArr.length;
  if (len === 0) {
    return;
  }
  const leastHot = badnessArr.at(0);
  const medianHot = badnessArr.at(Math.floor(len / 2));
  const mostHot = badnessArr.at(-1);
  if (
    leastHot === undefined ||
    medianHot === undefined ||
    mostHot === undefined
  ) {
    return;
  }

  writer('Hot import chain:\n');
  for (const hotModule of hotChain) {
    const up = hotModule.importedBy.length;
    const down = hotModule.imports.length;
    const arrowUp = up > 0 ? up + '\u2191' : '';
    const arrowDown = down > 0 ? down + '\u2193' : '';
    const prefix = arrowUp.padStart(6) + arrowDown.padStart(6);
    const pathText = denormalizePath(hotModule.path, cwd);

    if (useColor) {
      const dim = '\x1b[2m';
      const bright = '\x1b[1m';
      const selectColor = hotModule === selected ? bright : dim;
      const reset = '\x1b[0m';
      const rgb = hotnessColor(hotModule.badness, leastHot, medianHot, mostHot);
      writer(
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
          pathText +
          reset +
          '\n',
      );
    } else {
      writer(prefix + '  ' + pathText + '\n');
    }
  }
  writer('\n');
}

export async function runHot(
  paths: string[],
  options: Options,
  debugOptions: DebugOptions,
  fileSystem: FileSystem,
): Promise<void> {
  const { writer, cwd } = options;
  if (paths.length === 0) {
    writer('No paths provided.\n');
    return;
  }

  /*
    Resolve hybrid path input: files are normalized to absolute paths,
    directories are expanded to all TypeScript modules within them.
  */
  const moduleSet = await resolveCommandScope(paths, fileSystem);

  if (moduleSet.size === 0) {
    writer('No TypeScript files found in the given paths.\n');
    return;
  }

  /*
    Resolve the git repo root from any path in the set.
    All paths belong to the same repo, so the choice is arbitrary.
  */
  // biome-ignore lint/style/noNonNullAssertion: moduleSet.size > 0 guard ensures values().next().value is defined
  const entryPath = moduleSet.values().next().value!;
  const repoRoot = findGitRepoRoot(entryPath);

  const db = openStorage(debugOptions, {
    verbose: false,
    fresh: options.fresh ?? false,
    basePath: repoRoot,
    inMemory: false,
  });

  try {
    await updateStorage(repoRoot, db, true, fileSystem, writer, {});
    const filePaths = Array.from(moduleSet);

    /*
      When project-scope is enabled, resolve each module's tsconfig so that
      cross-project imports are filtered per-module rather than against a
      single representative's tsconfig.
    */
    let moduleTsconfigMap: Map<string, string> | undefined;
    if (options.projectScope === true) {
      const tsconfigs = await Promise.all(
        filePaths.map((path) =>
          getTsconfigPathForFile(repoRoot, path, fileSystem),
        ),
      );
      const entries: [string, string][] = filePaths.flatMap((path, i) => {
        const tsconfig = tsconfigs[i];
        if (tsconfig == null) {
          return [];
        }
        return [[path, tsconfig]];
      });
      moduleTsconfigMap = new Map(entries);
    }

    const hotMods = buildHotModuleGraph(db, filePaths, moduleTsconfigMap);
    const scoredMods = calculateAllScores(hotMods);

    const hotArray = Object.values(scoredMods);
    hotArray.sort((a, b) => b.badness - a.badness);

    const selected = selectHotModule(scoredMods, hotArray, options);

    printTopModules(hotArray, cwd, writer);

    const importedByChain = buildImportedByChain(scoredMods, selected);
    const importChain = buildImportChain(scoredMods, selected);
    const hotChain = [...importedByChain.reverse(), selected, ...importChain];

    printHotChain(hotChain, selected, cwd, { useColor: options.color, writer });
  } finally {
    db.save();
  }
}
