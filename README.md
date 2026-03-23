# TSLOR - TypeScript Large Offline Refactor

Fast, safe refactoring tools for large TypeScript monorepos with transparent Vue SFC support.

**Note:** This is a personal tool built to scratch my own itch. It works well for its intended purpose, but the code quality reflects that — expect rough edges, missing error handling, and limited documentation. Use at your own risk.

## Installation

Requires Node.js 18+ and Git.

```bash
npm install -g git+https://github.com/rolfwr/tslor.git
```

This builds the CLI from source during install and makes the `tslor` command available globally. To update, run the same command again.

To uninstall:

```bash
npm uninstall -g tslor
```

## What TSLOR Does

TSLOR provides command-line tools for refactoring operations that become slow or unreliable in IDEs when working with large codebases:

- Extract symbols from one module to another with automatic dependency resolution
- Move files and update all imports across the codebase
- Analyze dependencies and find architectural issues like cycles and bottlenecks
- Search and trace symbol usage across projects

All operations work identically with TypeScript and Vue Single File Components through transparent `<script>` block extraction.

## Quick Start

Find architectural bottlenecks:

```bash
tslor hot .
```

Extract symbols safely using the propose/apply pattern:

```bash
tslor propose-split src/utils.ts src/date-utils.ts formatDate parseDate
tslor diff          # preview changes
tslor apply --verify 'npm test'   # apply with automatic rollback if tests fail
```

Move a file and update all imports:

```bash
tslor mv src/old-path.ts src/new-path.ts
```

Run `tslor --help` for all available commands.

## Core Commands

**Refactoring:** `propose-split` and `split` extract symbols with dependency resolution, `apply` executes proposed changes with optional verification, `diff` previews changes as unified diffs, `mv` moves files and updates imports.

**Analysis:** `hot` finds bottleneck modules, `cycles` detects circular dependencies, `dependencies` lists transitive dependencies, `imports` finds who imports a module, `grep` provides fast symbol search.

## How It Works

TSLOR separates concerns through three phases. Static analysis parses TypeScript ASTs without filesystem access, resolves imports, and persists to JSONL with grouped indexing for O(1) lookups. Plan generation queries this indexed data to determine dependencies and creates execution plans with checksums. Transformation executes plans atomically with optional verification and automatic rollback.

The propose/apply pattern lets you review refactoring plans before execution. Checksum validation prevents stale plans from being applied.

## Development

```bash
pnpm install
pnpm check              # build + run all tests
tsx src/tslor.ts <cmd>   # run during development without building
```

## License

[License information to be added]
