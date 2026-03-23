# TSLOR Architecture

TSLOR is built as a layered architecture with clear separation between analysis, planning, and execution phases.

## Three-Phase Processing

TSLOR's speed and safety come from separating analysis, planning, and execution into distinct phases that can be independently verified.

### Static Analysis and Indexing

The analysis phase uses a two-step strategy avoiding expensive semantic resolution. First, the `parseModule()` function in `src/indexing.ts` parses TypeScript files using ts-morph with a custom `TransformingFileSystem`, extracting import and export declarations using only static AST features. A critical constraint enforced by tests: no filesystem access during parsing. This produces lightweight `StaticModuleInfo` objects while Vue SFCs are transparently transformed to pure TypeScript.

Second, import resolution resolves module specifiers like `'./utils'` to absolute paths using tsconfig.json path mappings and project references, linking imports to their target exports.

Third, persistent storage saves results in `_objstore.jsonl` using one JSON object per line. The storage system implements _grouped indexing_, a technique where each object belongs to multiple named groups functioning as secondary indexes in a database. This enables O(1) lookups for common query patterns without loading entire datasets.

### Grouped Indexing Strategy

The indexing scheme uses named groups as keys for efficient lookups. Each import statement gets indexed multiple ways simultaneously: by its primary key for direct access, by source file for "what does this file import" queries, and by imported symbol name for "where is this symbol used" queries.

| Index Key Pattern | Purpose |
|-------------------|---------|
| `import\|{path}\|{index}` | Individual import statements (primary key) |
| `importPath\|{path}` | All imports from a file ("show me everything file X imports") |
| `exportPath\|{path}` | All files importing this path ("who imports file X") |
| `export\|{path}\|{name}` | Specific export lookups ("where is symbol Y exported from") |
| `symbolName\|{name}` | Cross-file symbol search ("find all uses of symbol Y") |
| `projectUse\|{from}\|{to}` | Cross-project dependencies in monorepos |
| `filetime\|{path}` | Modification timestamps for incremental updates |

The entire index loads into memory for O(1) queries. Incremental updates re-analyze only files with changed timestamps by comparing `filetime` entries against current file modification times, making re-indexing nearly instant after small changes.

### Plan Generation

Commands generate execution plans without modifying files. Most commands (`propose-mv`, `propose-rename`, etc.) use indexed data through the `Storage` class in `src/storage.ts` to query cross-file dependencies. However, `propose-split` is unique: it only uses single-file analysis via `parseModule()` because its re-export strategy provides backward compatibility without needing to update import sites across the codebase. The split operation determines which symbols depend on others within the file, what imports must move with extracted symbols, what re-exports are needed, and whether circular dependencies prevent the refactoring—all from analyzing just the source file.

Currently, `propose-split` aborts if asked to move all exported symbols, directing users to `tslor mv` instead. In the future, when we implement "replace re-export with direct import" refactoring, we can decompose `mv` into "split every symbol out" followed by "replace re-exports with direct imports", unifying the implementation.

Plan creation by `src/plan.ts` generates a `TslorPlan` object containing file operations, SHA256 checksums of all affected files, and full undo information. This writes to `.tslor-plan.json` for review without modifying source files. Plans can be examined through `diff` command, committed to version control for team review, or run in CI/CD pipelines.

### Transformation

The `apply` command in `src/runApply.ts` executes plans with safety guarantees. Validation verifies the plan exists and SHA256 checksums match current files to prevent applying stale plans. Atomic execution applies all changes or none. Optional verification runs user-specified commands like `npm test`. Automatic rollback undoes all changes if verification fails using undo information from the plan. An audit trail archives each applied plan as `.applied-{timestamp}.json`.

This architecture enables speed through static analysis being 100x+ faster than semantic resolution, safety through propose/apply pattern enabling review and rollback, scale through grouped indexing providing O(1) queries, composability where separate phases allow verification between steps, and auditability through plan files creating a permanent record.

## Core Components

The CLI layer in `src/tslor.ts` provides a Commander.js-based interface handling argument parsing and routing to command handlers. Command handlers in `src/run*.ts` follow consistent patterns: early path normalization using `pathUtils.ts`, opening and updating storage, executing command-specific logic, and formatting output.

The plan system in `src/plan.ts` implements the propose/apply pattern through the `TslorPlan` interface defining plan structure, checksum validation detecting stale plans, change execution with rollback support, and audit trail archiving.

The indexing system in `src/indexing.ts` enforces a critical constraint: `parseModule()` must never trigger filesystem access, verified by tests using `parseIsolatedSourceCode()`. AST parsing produces `StaticModuleInfo`, import resolution converts to absolute paths, and module inspection enables dependency analysis.

The storage layer combines `src/storage.ts` and `src/objstore.ts` for JSONL-based persistence with in-memory indexes. Grouped indexing enables O(1) lookups. The `Storage` class provides a domain-specific API over the generic `ObjStore`.

Refactoring primitives in `src/splitModule.ts` handle dependency graph construction within modules through `buildIntraModuleDependencies()`, symbol extraction and dependency analysis through `analyzeSplit()`, code generation for new modules through `generateNewModuleSource()`, and circular dependency detection.

The `TransformingFileSystem` class in `src/transformingFileSystem.ts` implements ts-morph's `FileSystemHost` interface. Vue SFC support works through transparent transformation: extracting TypeScript from `<script>` tags, letting ts-morph process pure TypeScript, then reinserting modified TypeScript back into the Vue structure. All commands work identically with `.vue` and `.ts` files.

## Data Flow Through TSLOR

The indexing pipeline flows from TypeScript and Vue files through `TransformingFileSystem` (extracting `<script>` content from Vue, passing TypeScript through), to ts-morph AST parsing by `parseModule()` without filesystem access, producing `StaticModuleInfo` with exports, imports, and dependencies, through import resolution converting specifiers like `'./utils'` to absolute paths, into storage with grouped indexing.

The refactoring pipeline starts with user commands like `tslor propose-split`, analyzes dependencies through single-file parsing and `buildIntraModuleDependencies()` (or queries the full index for cross-file operations like `mv`), generates a plan as `TslorPlan` with changes and undo information, goes through human review and testing, applies changes atomically, runs optional verification with automatic rollback on failure, and archives the plan as `.applied-{timestamp}.json`.

## Performance Characteristics

Indexing achieves initial processing of approximately 5000 files in under 2 minutes. Incremental updates only re-analyze files with changed timestamps. Memory usage keeps the entire index in memory consuming less than 2GB for large monorepos.

Query performance provides O(1) symbol lookup using secondary indexes, O(V + E) import chain through graph traversal, and O(1) cross-project dependencies using grouped indexes.

Storage uses JSONL format providing faster bulk loading than SQLite for this workload, trading higher memory usage and lack of relational queries for performance.

## Key Design Patterns

Early normalization converts all paths to absolute immediately upon entry, denormalizing only for display. Filesystem isolation enforces that `parseModule()` never accesses the filesystem through test suite using stubbed filesystem in `parseIsolatedSourceCode.ts`. Grouped indexing lets objects belong to multiple named groups simultaneously, enabling O(1) lookups for common query patterns. Propose/apply separation keeps analysis and planning completely separate from execution, enabling review and rollback. Vue SFC transparency through the filesystem transformation layer makes Vue support zero-cost to refactoring logic.
