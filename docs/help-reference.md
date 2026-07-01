# TSLOR Help Reference

Auto-generated documentation — regenerate with `pnpm run generate:help`.

## tslor --help

```
Usage: tslor [options] [command]

TypeScript Large Offline Refactor

Options:
  -O, --optimize                                              Attempt to optimize the operation
  -s, --symbol                                                Use symbols when parsing
  --fresh                                                     Delete the index database before running
  --trace-id <id>                                             Enable debug tracing for specific object ID
  -h, --help                                                  display help for command

Commands:
  dependencies [options] <paths...>                           List all modules that transitively depend on the given modules
  imports <path>                                              List modules that directly import the given module
  import-chain <fromPath> <toPath>                            Trace the import path from one module to another
  inspect <path>                                              Parse a TypeScript or Vue SFC file and print its module structure as JSON
  mv <oldPath> <newPath>                                      Move a TypeScript or Vue SFC file and update all imports that reference it
  project-use [options] <fromTsconfig> <toTsconfig>           List cross-project dependencies between two tsconfig projects
  symbol-usage <project> <symbolName>                         Find all modules in a project that import a named symbol
  trace-imports [options] <entryFile>                         Show all symbols imported by a file, grouped by source module
  grep [options] <directory> <symbolName>                     Find modules that export a symbol matching the given name
  cycles [options] <directory>                                Detect and report circular import dependencies
  coupling [options] <path>                                   Analyze internal coupling between declarations in a module or class
  tscat <path>                                                Print the <script> content of a TypeScript or Vue SFC file
  needs <path>                                                Trace the import path from a module to a Node.js built-in dependency
  split [options] <sourceModule> <targetModule> <symbols...>  Extract symbols to a new module and apply the changes immediately
  propose-split <sourceModule> <targetModule> <symbols...>    Generate a plan to extract symbols to a new module
  propose-import-directly <directory>                         Generate a plan to replace imports through barrel files with direct imports
  propose-purge-reexport <directory>                          Generate a plan to remove re-exports that nothing imports
  normalize-namespace-imports <directory>                     Generate a plan to replace namespace imports with explicit named imports
  replace-type-use [options] <directory>                      Generate a plan to replace one type with another across a codebase
  normalize-imports <directory>                               Generate a plan to merge duplicate imports from the same module
  type-leaf-usage [options] <directory> <types...>            Find modules that import specified types but are not themselves type-imported
  apply [options] [plan-file]                                 Apply changes from a refactoring plan, with optional verification and rollback
  diff [options] [plan-file]                                  Preview changes from a refactoring plan as a unified diff
  hot [options] <paths...>                                    Rank modules by how heavily they are imported across a codebase
  tsort [options] <paths...>                                  Print modules in topological order of their import dependencies
  import-groups [options] <paths...>                          Find modules that share identical import sets and rank groups by size
  help [command]                                              display help for command
```

## Command Reference

### `dependencies`

```
Usage: tslor dependencies [options] <paths...>

List all modules that transitively depend on the given modules

Options:
  -p, --project-scope  Only list modules within the same project
  -h, --help           display help for command
```

### `imports`

```
Usage: tslor imports [options] <path>

List modules that directly import the given module

Options:
  -h, --help  display help for command
```

### `import-chain`

```
Usage: tslor import-chain [options] <fromPath> <toPath>

Trace the import path from one module to another

Options:
  -h, --help  display help for command
```

### `inspect`

```
Usage: tslor inspect [options] <path>

Parse a TypeScript or Vue SFC file and print its module structure as JSON

Options:
  -h, --help  display help for command
```

### `mv`

```
Usage: tslor mv [options] <oldPath> <newPath>

Move a TypeScript or Vue SFC file and update all imports that reference it

Options:
  -h, --help  display help for command
```

### `project-use`

```
Usage: tslor project-use [options] <fromTsconfig> <toTsconfig>

List cross-project dependencies between two tsconfig projects

Options:
  --symbols   Show specific symbols used across projects
  -h, --help  display help for command
```

### `symbol-usage`

```
Usage: tslor symbol-usage [options] <project> <symbolName>

Find all modules in a project that import a named symbol

Options:
  -h, --help  display help for command
```

### `trace-imports`

```
Usage: tslor trace-imports [options] <entryFile>

Show all symbols imported by a file, grouped by source module

Options:
  --from-project <project>  Filter imports from a specific project
  -h, --help                display help for command
```

### `grep`

```
Usage: tslor grep [options] <directory> <symbolName>

Find modules that export a symbol matching the given name

Options:
  -u, --uses     Show where the symbols are imported/used
  -v, --verbose  Show indexing progress and save confirmation
  -h, --help     display help for command
```

### `cycles`

```
Usage: tslor cycles [options] <directory>

Detect and report circular import dependencies

Options:
  -d, --directories  Find cycles between directories instead of individual
                     modules
  -g, --graphviz     Output cycles in Graphviz DOT format for visualization
  -a, --ascii        Output cycles as ASCII art graph for visualization
  -f, --fancy        Output cycles with Unicode characters and colors for
                     enhanced visualization
  -h, --help         display help for command
```

### `coupling`

```
Usage: tslor coupling [options] <path>

Analyze internal coupling between declarations in a module or class

Options:
  --class <name>                    Analyze members of the named class instead
                                    of module scope
  -g, --graphviz                    Output coupling graph in Graphviz DOT format
  --graphviz-depth-zero-one-subset  Output only the depth-0/1 SCC subset as
                                    Graphviz DOT
  -h, --help                        display help for command
```

### `tscat`

```
Usage: tslor tscat [options] <path>

Print the <script> content of a TypeScript or Vue SFC file

Options:
  -h, --help  display help for command
```

### `needs`

```
Usage: tslor needs [options] <path>

Trace the import path from a module to a Node.js built-in dependency

Options:
  -h, --help  display help for command
```

### `split`

```
Usage: tslor split [options] <sourceModule> <targetModule> <symbols...>

Extract symbols to a new module and apply the changes immediately

Options:
  -n, --dry-run  [DEPRECATED] Use propose-split instead
  -h, --help     display help for command
```

### `propose-split`

```
Usage: tslor propose-split [options] <sourceModule> <targetModule> <symbols...>

Generate a plan to extract symbols to a new module

Options:
  -h, --help  display help for command
```

### `propose-import-directly`

```
Usage: tslor propose-import-directly [options] <directory>

Generate a plan to replace imports through barrel files with direct imports

Options:
  -h, --help  display help for command
```

### `propose-purge-reexport`

```
Usage: tslor propose-purge-reexport [options] <directory>

Generate a plan to remove re-exports that nothing imports

Options:
  -h, --help  display help for command
```

### `normalize-namespace-imports`

```
Usage: tslor normalize-namespace-imports [options] <directory>

Generate a plan to replace namespace imports with explicit named imports

Options:
  -h, --help  display help for command
```

### `replace-type-use`

```
Usage: tslor replace-type-use [options] <directory>

Generate a plan to replace one type with another across a codebase

Options:
  --source-type <name>         Type name to replace
  --source-module <specifier>  Import specifier for the source type
  --target-type <name>         Replacement type name
  --target-module <specifier>  Import specifier for the target type
  -h, --help                   display help for command
```

### `normalize-imports`

```
Usage: tslor normalize-imports [options] <directory>

Generate a plan to merge duplicate imports from the same module

Options:
  -h, --help  display help for command
```

### `type-leaf-usage`

```
Usage: tslor type-leaf-usage [options] <directory> <types...>

Find modules that import specified types but are not themselves type-imported

Options:
  --all       Include modules that define the types
  -h, --help  display help for command
```

### `apply`

```
Usage: tslor apply [options] [plan-file]

Apply changes from a refactoring plan, with optional verification and rollback

Options:
  --force             Apply even if checksums have changed
  --verify <command>  Run shell command after applying; rollback if it fails
  -h, --help          display help for command
```

### `diff`

```
Usage: tslor diff [options] [plan-file]

Preview changes from a refactoring plan as a unified diff

Options:
  --stats       Show change statistics instead of full diff
  --names-only  Show only file names that will be changed
  -h, --help    display help for command
```

### `hot`

```
Usage: tslor hot [options] <paths...>

Rank modules by how heavily they are imported across a codebase

Options:
  --select <path>      Select a specific module to analyze instead of the
                       hottest
  -p, --project-scope  Only consider imports within the same project
  -h, --help           display help for command
```

### `tsort`

```
Usage: tslor tsort [options] <paths...>

Print modules in topological order of their import dependencies

Options:
  -p, --project-scope  Only consider imports within the same project
  -h, --help           display help for command
```

### `import-groups`

```
Usage: tslor import-groups [options] <paths...>

Find modules that share identical import sets and rank groups by size

Options:
  -p, --project-scope  Only consider imports within the same project
  -h, --help           display help for command
```
