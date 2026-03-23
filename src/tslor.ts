#!/usr/bin/env node
import { runImports } from './runImports.js';
import { runMv } from './runMv.js';
import { runProjectUse } from './runProjectUse.js';
import { runDependencies } from './runDependencies.js';
import { runSplit } from './runSplit.js';
import { runProposeSplit } from './runProposeSplit.js';
import { runApply } from './runApply.js';
import { runDiff } from './runDiff.js';
import { runSymbolUsage } from './runSymbolUsage.js';
import { runTraceImports } from './runTraceImports.js';
import { runGrep } from './runGrep.js';
import { runCycles } from './runCycles.js';
import { runNeeds } from './runNeeds.js';
import { runHot } from './runHot.js';
import { runTsort } from './runTsort.js';
import { program } from 'commander';
import { findGitRepoRoot } from './project.js';
import { inspectModule } from './indexing.js';
import { runImportChain } from './runImportChain.js';
import { runTscat } from './runTscat.js';
import { runProposeImportDirectly } from './runProposeImportDirectly.js';
import { runProposePurgeReexport } from './runProposePurgeReexport.js';
import { runReplaceTypeUse } from './runReplaceTypeUse.js';
import { runTypeLeafUsage } from './runTypeLeafUsage.js';
import { GitRepositoryRootProvider } from './repositoryRootProvider.js';
import { RealFileSystem } from './filesystem.js';
import { dirname, resolve } from 'path';
import { DebugOptions } from './objstore.js';

function getDebugOptions(cmd: any): DebugOptions {
  const globalOptions = cmd.parent?.opts() || {};
  return { traceId: globalOptions.traceId || null };
}

program
  .name('tslor')
  .description('TypeScript Large Offline Refactor')
  .option('-O, --optimize', 'Attempt to optimize the operation')
  .option('-s, --symbol', 'Use symbols when parsing')
  .option('--trace-id <id>', 'Enable debug tracing for specific object ID');

program
  .command('dependencies <paths...>')
  .description('List transitive module imports')
  .option('-p, --project-scope', 'Only list modules within the same project')
  .action(async (paths: string[], opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runDependencies(paths, opts, debugOptions, fileSystem);
  });

program
  .command('imports <path>')
  .description('List modules importing the given module')
  .action(async (path: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runImports(path, debugOptions, fileSystem);
  });

program
  .command('import-chain <fromPath> <toPath>')
  .description('List the import chain from one module to another')
  .action(async (fromPath: string, toPath: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runImportChain(fromPath, toPath, debugOptions, fileSystem);
  });

program
  .command('inspect <path>')
  .description('Inspect a TypeScript file')
  .action(async (path: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    const absolutePath = resolve(path);
    const repoRoot = findGitRepoRoot(dirname(absolutePath));
    const moduleInfo = await inspectModule(repoRoot, absolutePath, fileSystem);
    console.log(JSON.stringify(moduleInfo, null, 2));
  });

program
  .command('mv <oldPath> <newPath>')
  .description('Move a TypeScript file and update imports')
  .action(async (oldPath: string, newPath: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runMv(oldPath, newPath, debugOptions, fileSystem);
  });

program
  .command('project-use <fromTsconfig> <toTsconfig>')
  .description('List modules from one project using modules from another project')
  .option('--symbols', 'Show specific symbols used across projects')
  .action(async (fromTsconfig: string, toTsconfig: string, opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runProjectUse(fromTsconfig, toTsconfig, opts, debugOptions, fileSystem);
  });

program
  .command('symbol-usage <project> <symbolName>')
  .description('Find all places where a specific symbol is used within a project')
  .action(async (project: string, symbolName: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runSymbolUsage(project, symbolName, debugOptions, fileSystem);
  });

program
  .command('trace-imports <entryFile>')
  .description('Show all symbols imported by an entry file')
  .option('--from-project <project>', 'Filter imports from a specific project')
  .action(async (entryFile: string, opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runTraceImports(entryFile, opts, debugOptions, fileSystem);
  });

program
  .command('grep <directory> <symbolName>')
  .description('Find where exported symbols are defined (loose search for exploration)')
  .option('-u, --uses', 'Show where the symbols are imported/used')
  .option('-v, --verbose', 'Show indexing progress and save confirmation')
  .action(async (directory: string, symbolName: string, opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runGrep(directory, symbolName, opts, debugOptions, fileSystem);
  });

program
  .command('cycles <directory>')
  .description('Find and report import cycles between modules as code smells')
  .option('-d, --directories', 'Find cycles between directories instead of individual modules')
  .option('-g, --graphviz', 'Output cycles in Graphviz DOT format for visualization')
  .option('-a, --ascii', 'Output cycles as ASCII art graph for visualization')
  .option('-f, --fancy', 'Output cycles with Unicode characters and colors for enhanced visualization')
  .action(async (directory: string, opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runCycles(directory, opts, debugOptions, fileSystem);
  });

program
  .command('tscat <path>')
  .description('Print the TypeScript module content of a file')
  .action(async (path: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    await runTscat(path, debugOptions);
  });

program
  .command('needs <path>')
  .description('Detect transitive runtime requirements')
  .action(async (path: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runNeeds(path, debugOptions, fileSystem);
  });

program
  .command('split <sourceModule> <targetModule> <symbols...>')
  .description('Split symbols (convenience: propose + apply)')
  .option('-n, --dry-run', '[DEPRECATED] Use propose-split instead')
  .action(async (sourceModule: string, targetModule: string, symbols: string[], opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runSplit(sourceModule, targetModule, symbols, opts, debugOptions, fileSystem);
  });

program
  .command('propose-split <sourceModule> <targetModule> <symbols...>')
  .description('Propose splitting symbols to a new module (creates .tslor-plan.json)')
  .action(async (sourceModule: string, targetModule: string, symbols: string[], cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runProposeSplit(sourceModule, targetModule, symbols, debugOptions, fileSystem);
  });

program
  .command('propose-import-directly <directory>')
  .description('Propose changing imports of re-exported symbols to point directly to original exports (creates .tslor-plan.json)')
  .action(async (directory: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const repoProvider = new GitRepositoryRootProvider();
    const fileSystem = new RealFileSystem();
    await runProposeImportDirectly(directory, debugOptions, repoProvider, fileSystem);
  });

program
  .command('propose-purge-reexport <directory>')
  .description('Propose removing unused re-exports from the codebase (creates .tslor-plan.json)')
  .action(async (directory: string, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const repoProvider = new GitRepositoryRootProvider();
    const fileSystem = new RealFileSystem();
    await runProposePurgeReexport(directory, debugOptions, repoProvider, fileSystem);
  });

program
  .command('replace-type-use <directory>')
  .description('Replace all usages of a type with another type')
  .requiredOption('--source-type <name>', 'Type name to replace')
  .requiredOption('--source-module <specifier>', 'Import specifier for the source type')
  .requiredOption('--target-type <name>', 'Replacement type name')
  .requiredOption('--target-module <specifier>', 'Import specifier for the target type')
  .action(async (directory: string, opts: any, cmd: any) => {
    const debugOptions = getDebugOptions(cmd);
    const repoProvider = new GitRepositoryRootProvider();
    const fileSystem = new RealFileSystem();
    await runReplaceTypeUse(directory, opts, debugOptions, repoProvider, fileSystem);
  });

program
  .command('type-leaf-usage <directory> <types...>')
  .description('Find leaf modules importing specified types (no transitive type-using dependencies)')
  .option('--all', 'Include modules that define the types')
  .action(async (directory: string, types: string[], opts: any, cmd: any) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runTypeLeafUsage(directory, types, opts, debugOptions, fileSystem);
  });

program
  .command('apply [plan-file]')
  .description('Apply a proposed refactoring plan')
  .option('--force', 'Apply even if checksums have changed')
  .option('--verify <command>', 'Run shell command after applying; rollback if it fails')
  .action(async (planFile: string | undefined, opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    await runApply(planFile, opts, debugOptions);
  });

program
  .command('diff [plan-file]')
  .description('Show unified diff of proposed changes')
  .option('--stats', 'Show change statistics instead of full diff')
  .option('--names-only', 'Show only file names that will be changed')
  .action(async (planFile: string | undefined, opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    await runDiff(planFile, opts, debugOptions);
  });

program
  .command('hot <directory>')
  .description('Visualize the hottest transitive import paths in a codebase')
  .option('--select <path>', 'Select a specific module to analyze instead of the hottest')
  .action(async (directory: string, opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runHot(directory, opts, debugOptions, fileSystem);
  });

program
  .command('tsort <paths...>')
  .description('Topologically sort modules by import dependencies')
  .option('-p, --project-scope', 'Only consider imports within the same project')
  .action(async (paths: string[], opts, cmd) => {
    const debugOptions = getDebugOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runTsort(paths, opts, debugOptions, fileSystem);
  });


/*
  File moved fixup strategy:

  - Identify all exports provided by the new file location.
  - Identify all exports at old file location that no longer is provided.
  - Identify all files that import any of the exports at the old location.
  - Rewrite the imports of these files to import from the new location.
*/
async function main() {
  program.parse(process.argv);
}

main().catch((err) => {
  console.error('tslor:', err);
  process.exit(1);
});
