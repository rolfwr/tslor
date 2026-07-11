/**
 * Generalized needs report (T8, D11, D13).
 *
 * Reports ambient names and external module specifiers that a module
 * (transitively) depends on, with no environment classification.
 * Uses the index to scope the traversal, then the sealed binder for
 * exact ambient-name classification at report time.
 */

import { findGitRepoRoot } from './project';
import { openStorage, type Storage } from './storage';
import { updateStorage } from './indexing';
import { DebugOptions } from './objstore';
import { normalizeAndValidatePath, denormalizePath } from './pathUtils';
import { FileSystem } from './filesystem';
import { filterTrulyAmbientNames } from './sealedBinder';

interface NeedsResult {
  modulePath: string;
  ambientNames: Set<string>;
  externalSpecifiers: readonly string[];
}

function formatNeedsResults(
  modulePath: string,
  absolutePath: string,
  repoRoot: string,
  results: NeedsResult[],
  writer: (message: string) => void,
): boolean {
  let shown = false;
  for (const result of results) {
    const names = [
      ...result.externalSpecifiers,
      ...result.ambientNames,
    ];

    if (!shown) {
      shown = true;
      writer(modulePath + ' depends on:\n');
    }

    names.sort();
    if (result.modulePath === absolutePath) {
      writer('  ' + names.join(', ') + ' (used directly)\n');
    } else {
      const relPath = denormalizePath(result.modulePath, repoRoot);
      writer('  ' + names.join(', ') + ' via ' + relPath + '\n');
    }
  }
  return shown;
}

export async function runNeeds(
  modulePath: string,
  debugOptions: DebugOptions,
  fresh: boolean,
  fileSystem: FileSystem,
  writer: (message: string) => void,
  verbose: boolean,
  ambientOnly: boolean,
) {
  const absolutePath = normalizeAndValidatePath(
    modulePath,
    'Module path',
    false,
  );
  const repoRoot = findGitRepoRoot(absolutePath);

  const db = openStorage(debugOptions, {
    verbose,
    fresh,
    basePath: repoRoot,
    inMemory: false,
  });
  await updateStorage(repoRoot, db, verbose, fileSystem, writer, {});
  db.save();

  const results = await findAmbientRequirements(
    db,
    absolutePath,
    new Set(),
    fileSystem,
    writer,
    ambientOnly,
  );

  const shown = formatNeedsResults(
    modulePath,
    absolutePath,
    repoRoot,
    results,
    writer,
  );

  if (!shown) {
    writer(ambientOnly
      ? 'No ambient dependencies found.\n'
      : 'No external dependencies found.\n',
    );
  }
}

/**
 * Compute ambient names for a single module (pure computation).
 *
 * Given source text (or null if unreadable) and candidates from the index,
 * filters candidates through the sealed binder. Falls back to unfiltered
 * candidates when source text is null.
 */
function computeModuleAmbientNames(
  sourceText: string | null,
  candidates: readonly string[],
  modulePath: string,
): Set<string> {
  if (candidates.length === 0) {
    return new Set<string>();
  }
  return sourceText
    ? filterTrulyAmbientNames(sourceText, candidates, { filePath: modulePath })
    : new Set(candidates);
}

/**
 * Walk the dependency graph collecting ambient requirements.
 * Returns one result per module that has dependencies.
 */
async function findAmbientRequirements(
  db: Storage,
  modulePath: string,
  visited: Set<string>,
  fileSystem: FileSystem,
  writer: (message: string) => void,
  ambientOnly: boolean,
): Promise<NeedsResult[]> {
  if (visited.has(modulePath)) {
    return [];
  }
  visited.add(modulePath);

  const results: NeedsResult[] = [];
  const needs = db.getModuleNeeds(modulePath);
  const candidates = needs ? needs.ambientNames : [];

  let sourceText: string | null = null;
  if (candidates.length > 0) {
    try {
      sourceText = await fileSystem.readFile(modulePath, 'utf-8');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      writer(
        'warning: unable to read ' + modulePath + ': ' + errMsg + '\n',
      );
    }
  }

  const ambientNames = computeModuleAmbientNames(
    sourceText,
    candidates,
    modulePath,
  );
  const externalSpecifiers = ambientOnly
    ? []
    : db.getExternalSpecifiers(modulePath);
  if (ambientNames.size > 0 || externalSpecifiers.length > 0) {
    results.push({ modulePath, ambientNames, externalSpecifiers });
  }

  for (const dep of db.getExporterPathsOfImport(modulePath)) {
    const depResults = await findAmbientRequirements(
      db,
      dep.path,
      visited,
      fileSystem,
      writer,
      ambientOnly,
    );
    results.push(...depResults);
  }

  return results;
}
