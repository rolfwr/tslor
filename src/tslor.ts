import { Command, OptionValues, program } from 'commander';
import { dirname, extname, resolve } from 'path';
import { CliError } from './errors';
import { RealFileSystem } from './filesystem';
import { inspectModule } from './indexing';
import { findGitRepoRoot } from './project';
import { GitRepositoryRootProvider } from './repositoryRootProvider';
import { runApply } from './runApply';
import { runCoupling } from './runCoupling';
import { runCycles } from './runCycles';
import { runDependencies } from './runDependencies';
import { runDiff } from './runDiff';
import { runGrep } from './runGrep';
import { runHot } from './runHot';
import { runImportChain } from './runImportChain';
import { runImportGroups } from './runImportGroups';
import { runImports } from './runImports';
import { runMv } from './runMv';
import { runNeeds } from './runNeeds';
import { runNormalizeImports } from './runNormalizeImports';
import { runNormalizeNamespaceImports } from './runNormalizeNamespaceImports';
import { runProjectUse } from './runProjectUse';
import { runProposeImportDirectly } from './runProposeImportDirectly';
import { runProposePurgeReexport } from './runProposePurgeReexport';
import { runProposeSplit } from './runProposeSplit';
import { runReplaceTypeUse } from './runReplaceTypeUse';
import { runSplit } from './runSplit';
import { runSymbolUsage } from './runSymbolUsage';
import { runTraceImports } from './runTraceImports';
import { runTscat } from './runTscat';
import { runTsort } from './runTsort';
import { runTypeLeafUsage } from './runTypeLeafUsage';

const writeStderr = process.stderr.write.bind(process.stderr);
const isInteractive = process.stdout.isTTY && !process.env.CI;
const forceColor = process.env.FORCE_COLOR;
const colorOutput =
  forceColor !== '0' && (forceColor !== undefined || process.stdout.isTTY);
const currentCwd = process.cwd();

/**
 * Extract global options from a subcommand's parent (the program).
 * Returns traceId for debug tracing and whether --fresh was requested.
 */
function getGlobalOptions(cmd: Command): {
  traceId: string | null;
  fresh: boolean;
} {
  const globalOptions = cmd.parent?.opts() ?? {};
  return {
    traceId:
      typeof globalOptions.traceId === 'string' ? globalOptions.traceId : null,
    fresh: globalOptions.fresh === true,
  };
}

program
  .name('tslor')
  .description('TypeScript Large Offline Refactor')
  .option('-O, --optimize', 'Attempt to optimize the operation')
  .option('-s, --symbol', 'Use symbols when parsing')
  .option('--fresh', 'Delete the index database before running')
  .option('--trace-id <id>', 'Enable debug tracing for specific object ID');

program
  .command('dependencies <paths...>')
  .description('List all modules that transitively depend on the given modules')
  .option('-p, --project-scope', 'Only list modules within the same project')
  .action(async (paths: string[], opts: { projectScope?: boolean }, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runDependencies(
      paths,
      { projectScope: opts.projectScope === true, fresh, writer: writeStderr },
      { traceId },
      fileSystem,
    );
  });

program
  .command('imports <path>')
  .description('List modules that directly import the given module')
  .action(async (path: string, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runImports(
      path,
      { traceId },
      fresh,
      fileSystem,
      writeStderr,
      isInteractive,
    );
  });

program
  .command('import-chain <fromPath> <toPath>')
  .description('Trace the import path from one module to another')
  .action(async (fromPath: string, toPath: string, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runImportChain(
      fromPath,
      toPath,
      { traceId },
      fresh,
      fileSystem,
      writeStderr,
    );
  });

program
  .command('inspect <path>')
  .description(
    'Parse a TypeScript or Vue SFC file and print its module structure as JSON',
  )
  .action(async (path: string) => {
    const fileSystem = new RealFileSystem();
    const absolutePath = resolve(path);

    const ext = extname(absolutePath);
    if (ext !== '.ts' && ext !== '.tsx' && ext !== '.vue') {
      throw new CliError(
        `${absolutePath} is not a supported file type (expected .ts, .tsx, .vue)`,
        {},
      );
    }

    const repoRoot = findGitRepoRoot(dirname(absolutePath));
    const moduleInfo = await inspectModule(repoRoot, absolutePath, fileSystem);
    if (!moduleInfo) {
      throw new CliError('No tsconfig found for ' + absolutePath, {});
    }
    console.log(JSON.stringify(moduleInfo, null, 2));
  });

program
  .command('mv <oldPath> <newPath>')
  .description(
    'Move a TypeScript or Vue SFC file and update all imports that reference it',
  )
  .action(async (oldPath: string, newPath: string, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runMv(oldPath, newPath, { traceId }, fresh, fileSystem, writeStderr);
  });

program
  .command('project-use <fromTsconfig> <toTsconfig>')
  .description('List cross-project dependencies between two tsconfig projects')
  .option('--symbols', 'Show specific symbols used across projects')
  .action(async (fromTsconfig: string, toTsconfig: string, opts, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runProjectUse(
      fromTsconfig,
      toTsconfig,
      opts,
      { traceId },
      fresh,
      fileSystem,
      writeStderr,
    );
  });

program
  .command('symbol-usage <project> <symbolName>')
  .description('Find all modules in a project that import a named symbol')
  .option(
    '--repo <path>',
    'Repository root to resolve relative project path against',
  )
  .action(async (project: string, symbolName: string, opts, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    const repoRoot = typeof opts.repo === 'string' ? opts.repo : undefined;
    await runSymbolUsage(
      project,
      symbolName,
      { traceId },
      { repoRoot, fresh, cwd: currentCwd },
      fileSystem,
      writeStderr,
    );
  });

program
  .command('trace-imports <entryFile>')
  .description('Show all symbols imported by a file, grouped by source module')
  .option('--from-project <project>', 'Filter imports from a specific project')
  .action(async (entryFile: string, opts, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runTraceImports(
      entryFile,
      opts,
      { traceId },
      fresh,
      fileSystem,
      writeStderr,
    );
  });

program
  .command('grep <directory> <symbolName>')
  .description('Find modules that export a symbol matching the given name')
  .option('-u, --uses', 'Show where the symbols are imported/used')
  .option('-v, --verbose', 'Show indexing progress and save confirmation')
  .action(async (directory: string, symbolName: string, opts, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runGrep(
      directory,
      symbolName,
      opts,
      { traceId },
      fresh,
      fileSystem,
      writeStderr,
    );
  });

program
  .command('cycles <directory>')
  .description('Detect and report circular import dependencies')
  .option(
    '-d, --directories',
    'Find cycles between directories instead of individual modules',
  )
  .option(
    '-g, --graphviz',
    'Output cycles in Graphviz DOT format for visualization',
  )
  .option('-a, --ascii', 'Output cycles as ASCII art graph for visualization')
  .option(
    '-f, --fancy',
    'Output cycles with Unicode characters and colors for enhanced visualization',
  )
  .action(async (directory: string, opts, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runCycles(
      directory,
      { ...opts, cwd: currentCwd },
      { traceId },
      fresh,
      fileSystem,
      writeStderr,
    );
  });

program
  .command('coupling <path>')
  .description(
    'Analyze internal coupling between declarations in a module or class',
  )
  .option(
    '--class <name>',
    'Analyze members of the named class instead of module scope',
  )
  .option('-g, --graphviz', 'Output coupling graph in Graphviz DOT format')
  .option(
    '--graphviz-depth-zero-one-subset',
    'Output only the depth-0/1 SCC subset as Graphviz DOT',
  )
  .action((path: string, opts) => {
    const classOption = typeof opts.class === 'string' ? opts.class : null;
    runCoupling(path, {
      ...(classOption !== null && { class: classOption }),
      graphviz: opts.graphviz === true,
      graphvizDepthZeroOneSubset: opts.graphvizDepthZeroOneSubset === true,
    });
  });

program
  .command('tscat <path>')
  .description('Print the <script> content of a TypeScript or Vue SFC file')
  .action(async (path: string, cmd) => {
    const { traceId } = getGlobalOptions(cmd);
    await runTscat(path, { traceId });
  });

program
  .command('needs <path>')
  .description(
    'Trace the import path from a module to a Node.js built-in dependency',
  )
  .action(async (path: string, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runNeeds(
      path,
      { traceId },
      fresh,
      fileSystem,
      writeStderr,
      isInteractive,
    );
  });

program
  .command('split <sourceModule> <targetModule> <symbols...>')
  .description(
    'Extract symbols to a new module and apply the changes immediately',
  )
  .option('-n, --dry-run', '[DEPRECATED] Use propose-split instead')
  .action(
    async (
      sourceModule: string,
      targetModule: string,
      symbols: string[],
      opts,
      _cmd,
    ) => {
      const fileSystem = new RealFileSystem();
      await runSplit(
        sourceModule,
        targetModule,
        symbols,
        opts,
        fileSystem,
        writeStderr,
        currentCwd,
      );
    },
  );

program
  .command('propose-split <sourceModule> <targetModule> <symbols...>')
  .description('Generate a plan to extract symbols to a new module')
  .action(
    async (
      sourceModule: string,
      targetModule: string,
      symbols: string[],
      _cmd,
    ) => {
      const fileSystem = new RealFileSystem();
      await runProposeSplit(
        sourceModule,
        targetModule,
        symbols,
        fileSystem,
        writeStderr,
        currentCwd,
      );
    },
  );

program
  .command('propose-import-directly <directory>')
  .description(
    'Generate a plan to replace imports through barrel files with direct imports',
  )
  .action(async (directory: string, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const repoProvider = new GitRepositoryRootProvider();
    const fileSystem = new RealFileSystem();
    await runProposeImportDirectly(
      directory,
      { traceId },
      fresh,
      repoProvider,
      fileSystem,
      writeStderr,
      currentCwd,
    );
  });

program
  .command('propose-purge-reexport <directory>')
  .description('Generate a plan to remove re-exports that nothing imports')
  .action(async (directory: string, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const repoProvider = new GitRepositoryRootProvider();
    const fileSystem = new RealFileSystem();
    await runProposePurgeReexport(
      directory,
      { traceId },
      fresh,
      repoProvider,
      fileSystem,
      writeStderr,
      currentCwd,
    );
  });

program
  .command('normalize-namespace-imports <directory>')
  .description(
    'Generate a plan to replace namespace imports with explicit named imports',
  )
  .action(async (directory: string, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const repoProvider = new GitRepositoryRootProvider();
    const fileSystem = new RealFileSystem();
    await runNormalizeNamespaceImports(
      directory,
      { traceId },
      fresh,
      repoProvider,
      fileSystem,
      writeStderr,
      currentCwd,
    );
  });

program
  .command('replace-type-use <directory>')
  .description(
    'Generate a plan to replace one type with another across a codebase',
  )
  .requiredOption('--source-type <name>', 'Type name to replace')
  .requiredOption(
    '--source-module <specifier>',
    'Import specifier for the source type',
  )
  .requiredOption('--target-type <name>', 'Replacement type name')
  .requiredOption(
    '--target-module <specifier>',
    'Import specifier for the target type',
  )
  .action(async (directory: string, opts: OptionValues, cmd: Command) => {
    const { sourceType, sourceModule, targetType, targetModule } = opts;
    if (
      typeof sourceType !== 'string' ||
      typeof sourceModule !== 'string' ||
      typeof targetType !== 'string' ||
      typeof targetModule !== 'string'
    ) {
      throw new CliError(
        'Missing required options: --source-type, --source-module, --target-type, --target-module',
        {},
      );
    }
    const { traceId, fresh } = getGlobalOptions(cmd);
    const repoProvider = new GitRepositoryRootProvider();
    const fileSystem = new RealFileSystem();
    await runReplaceTypeUse(
      directory,
      { sourceType, sourceModule, targetType, targetModule },
      {
        debugOptions: { traceId },
        fresh,
        repoProvider,
        fileSystem,
        writer: writeStderr,
        cwd: currentCwd,
      },
    );
  });

program
  .command('normalize-imports <directory>')
  .description(
    'Generate a plan to merge duplicate imports from the same module',
  )
  .action(async (directory: string) => {
    const repoProvider = new GitRepositoryRootProvider();
    const fileSystem = new RealFileSystem();
    await runNormalizeImports(
      directory,
      repoProvider,
      fileSystem,
      writeStderr,
      currentCwd,
    );
  });

program
  .command('type-leaf-usage <directory> <types...>')
  .description(
    'Find modules that import specified types but are not themselves type-imported',
  )
  .option('--all', 'Include modules that define the types')
  .action(
    async (
      directory: string,
      types: string[],
      opts: OptionValues,
      cmd: Command,
    ) => {
      const { traceId, fresh } = getGlobalOptions(cmd);
      const fileSystem = new RealFileSystem();
      await runTypeLeafUsage(
        directory,
        types,
        { all: opts['all'] === true },
        { traceId },
        fresh,
        fileSystem,
        writeStderr,
      );
    },
  );

program
  .command('apply [plan-file]')
  .description(
    'Apply changes from a refactoring plan, with optional verification and rollback',
  )
  .option('--force', 'Apply even if checksums have changed')
  .option(
    '--verify <command>',
    'Run shell command after applying; rollback if it fails',
  )
  .action(async (planFile: string | undefined, opts, _cmd) => {
    await runApply(planFile, { ...opts, writer: writeStderr }, currentCwd);
  });

program
  .command('diff [plan-file]')
  .description('Preview changes from a refactoring plan as a unified diff')
  .option('--stats', 'Show change statistics instead of full diff')
  .option('--names-only', 'Show only file names that will be changed')
  .action(async (planFile: string | undefined, opts) => {
    await runDiff(planFile, { ...opts }, writeStderr, currentCwd);
  });

program
  .command('hot <paths...>')
  .description(
    'Rank modules by how heavily they are imported across a codebase',
  )
  .option(
    '--select <path>',
    'Select a specific module to analyze instead of the hottest',
  )
  .option(
    '-p, --project-scope',
    'Only consider imports within the same project',
  )
  .action(
    async (
      paths: string[],
      opts: { select?: string; projectScope?: boolean },
      cmd,
    ) => {
      const { traceId, fresh } = getGlobalOptions(cmd);
      const fileSystem = new RealFileSystem();
      await runHot(
        paths,
        {
          select: typeof opts.select === 'string' ? opts.select : null,
          projectScope: opts.projectScope === true,
          fresh,
          writer: writeStderr,
          color: colorOutput,
          cwd: currentCwd,
        },
        { traceId },
        fileSystem,
      );
    },
  );

program
  .command('tsort <paths...>')
  .description(
    'Print modules in topological order of their import dependencies',
  )
  .option(
    '-p, --project-scope',
    'Only consider imports within the same project',
  )
  .action(async (paths: string[], opts: { projectScope?: boolean }, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runTsort(
      paths,
      {
        projectScope: opts.projectScope === true,
        fresh,
        writer: writeStderr,
        cwd: currentCwd,
      },
      { traceId },
      fileSystem,
    );
  });

program
  .command('import-groups <paths...>')
  .description(
    'Find modules that share identical import sets and rank groups by size',
  )
  .option(
    '-p, --project-scope',
    'Only consider imports within the same project',
  )
  .action(async (paths: string[], opts: { projectScope?: boolean }, cmd) => {
    const { traceId, fresh } = getGlobalOptions(cmd);
    const fileSystem = new RealFileSystem();
    await runImportGroups(
      paths,
      {
        projectScope: opts.projectScope === true,
        fresh,
        writer: writeStderr,
        cwd: currentCwd,
      },
      { traceId },
      fileSystem,
    );
  });

async function main() {
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  handleCliError(err);
});

process.on('unhandledRejection', (reason) => {
  handleCliError(reason);
});

function handleCliError(err: unknown): never {
  if (err instanceof CliError) {
    console.error('tslor:', err.message);
    if (err.unexpected && err.cause instanceof Error) {
      console.error(err.cause.stack);
    }
    process.exit(err.exitCode);
  }
  if (err instanceof Error) {
    console.error('tslor:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
  console.error('tslor:', err);
  process.exit(1);
}
