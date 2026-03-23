# Resolving Import Cycles

Import cycles create initialization order problems, slow builds, and architectural complexity. TSLOR resolves cycles through a universal three-phase workflow that breaks the cycle safely, updates imports across the codebase, and removes temporary scaffolding. The workflow is identical for every cycle—only the initial analysis differs.

## The Universal Three-Phase Workflow

Every import cycle is resolved using the same sequence of commands. Phase 1 splits modules to break the cycle while preserving backward compatibility through re-exports. Phase 2 updates imports throughout the codebase to bypass these re-exports. Phase 3 removes the now-unused re-exports, leaving a clean codebase.

The propose/apply pattern ensures safety at each step. The `propose-split`, `propose-import-directly`, and `propose-purge-reexport` commands generate plans without modifying code and display a preview of the changes. The `diff` command provides additional options for reviewing changes if needed. The `apply --verify` command executes changes and automatically rolls back if verification fails. Only one plan exists at a time—each propose command overwrites any unapplied plan.

The `--verify` flag accepts any shell command that returns exit code 0 on success. Use whatever command your codebase employs to verify compilation—common choices include `tsc --noEmit` for TypeScript type-checking, `npm test` or `pnpm test` for test suites, or project-specific build commands. The examples in this guide use `tsc --noEmit` and `npm test` as illustrations, but substitute your project's verification command.

This workflow applies to all cycles regardless of complexity. A simple two-module cycle (`moduleA.ts` ↔ `moduleB.ts`) uses the same three phases as a complex multi-module cycle. The commands never change; only the arguments to `propose-split` differ based on your analysis of the cycle structure.

## Command Reference

| Command | Purpose | Modifies Code |
|---------|---------|---------------|
| `cycles <directory>` | Detect and visualize import cycles | No |
| `propose-split <source> <target> <symbols...>` | Plan symbol extraction to break cycles | No - creates plan only |
| `propose-import-directly <directory>` | Plan import updates to bypass re-exports | No - creates plan only |
| `propose-purge-reexport <directory>` | Plan removal of unused re-exports | No - creates plan only |
| `diff [plan-file]` | Preview proposed changes | No |
| `apply [--verify cmd] [plan-file]` | Execute plan with optional verification | **Yes** |

The `cycles` command supports visualization options: `--ascii` for simple diagrams, `--fancy` for colored Unicode output, and `--graphviz` for external tools. See `runCycles()` in `src/runCycles.ts` for the implementation using Tarjan's algorithm for strongly connected components.

## Detecting Cycles

Run `cycles` on your target directory to identify all import cycles. The command uses Tarjan's algorithm to find strongly connected components in the module dependency graph. Each cycle shows the circular path of imports.

```bash
npx tsx src/tslor.ts cycles /path/to/codebase
```

Common cycle patterns include simple two-module cycles where modules share types or utilities, multi-module chains indicating architectural issues, and re-export cycles where intermediate modules create circular paths. The simplest cycles resolve first—they provide practice with the workflow before tackling complex architectural problems.

Start with cycles in foundational modules that many other modules import. Resolving these cycles often simplifies or eliminates other cycles downstream. Cycles causing runtime initialization problems take priority over purely architectural concerns.

## Analyzing Cycles to Determine Split Arguments

The workflow is universal, but analysis determines the arguments for `propose-split`. You must decide which module to extract symbols from (source), which module to extract symbols to (target), and which symbols to extract. This analysis step is the only variation between different cycles.

### Shared Code Pattern

When both modules need the same types, utilities, or interfaces, extract them to a new shared module. This is the most common pattern. The shared module has no dependencies on either original module, breaking the cycle cleanly.

For example, if `moduleA.ts` and `moduleB.ts` both use `SharedType`, extract it:
```bash
npx tsx src/tslor.ts propose-split moduleA.ts shared.ts SharedType
```

After the three phases complete, both modules import `SharedType` from `shared.ts`. The implementation details remain in their respective modules—only the shared code moves.

### Asymmetric Dependency Pattern

When one module heavily imports from another but the reverse dependency is minimal, move the minimal symbols to reverse the direction. This converts a bidirectional cycle into a clean unidirectional dependency.

If `moduleA.ts` imports many things from `moduleB.ts` while `moduleB.ts` imports only `helperFunction` from `moduleA.ts`, extract `helperFunction` to `moduleB.ts`:
```bash
npx tsx src/tslor.ts propose-split moduleA.ts moduleB.ts helperFunction
```

After completion, `moduleB.ts` contains everything it needs, and only `moduleA.ts` imports from `moduleB.ts`.

### Type-Only Cycle Pattern

When modules need each other's types but not implementations, extract type definitions to a separate types module. This pattern commonly occurs in domain-driven designs where different bounded contexts reference each other's entities.

Extract type definitions to a dedicated file:
```bash
npx tsx src/tslor.ts propose-split users.ts types.ts UserType UserInterface
```

Then extract the other module's types to the same file. Both modules import types from `types.ts` while keeping implementations separate.

### Decision Process

Ask these questions in order. Is there shared code both modules need? Extract it to a new shared module. If not, is one dependency minimal while the other is heavy? Move the minimal symbols to reverse the dependency direction. If neither applies, is it only types that cycle? Extract types to a dedicated types file. If none of these patterns fit, the modules may be too tightly coupled—consider whether they should be merged.

## Phase 1: Breaking the Cycle with propose-split

The `propose-split` command analyzes dependencies and creates a plan to extract symbols from a source module to a target module. The command automatically determines transitive dependencies—if you request `SymbolA` and it depends on `HelperB`, both move together. See `buildIntraModuleDependencies()` and `analyzeSplit()` in `src/splitModule.ts` for the dependency analysis implementation.

```bash
npx tsx src/tslor.ts propose-split sourceModule.ts targetModule.ts Symbol1 Symbol2
npx tsx src/tslor.ts apply --verify 'tsc --noEmit'
```

The propose command displays a summary of changes and a unified diff. The plan creates the target module with extracted symbols, removes those symbols from the source module, and adds re-exports to the source module so existing imports continue working. This re-export strategy ensures the split operation never breaks existing code—only two files change regardless of how many files import from the source module.

After applying, the cycle is broken. If module B imported from module A and module A imported from module B, the symbols now live in a new module C. Module A re-exports them from C, so module B's imports still work through the re-export. The cycle becomes A → C and B → A → C, which contains no cycle.

Verify type-checking passes after the split using `tsc --noEmit`. If verification fails, changes automatically roll back. See the propose/apply pattern documentation in `docs/propose-apply-pattern.md` for details on checksum validation and rollback mechanisms.

Commit after successful application to preserve a clean checkpoint before proceeding to phase 2.

## Phase 2: Updating Imports with propose-import-directly

The `propose-import-directly` command scans the codebase for imports using re-exports and proposes changing them to import directly from the original source. This phase updates all import statements throughout the codebase to bypass the temporary re-exports created in phase 1.

```bash
npx tsx src/tslor.ts propose-import-directly /path/to/directory
npx tsx src/tslor.ts apply --verify 'tsc --noEmit'
```

The command examines every import statement in the directory. When it finds an import using a re-exported symbol, it proposes changing that import to point directly to the module where the symbol is actually defined. Safety checks verify the symbol exists in the target module before proposing the change—see `runProposeImportDirectly()` in `src/runProposeImportDirectly.ts` for the verification logic.

After applying, imports throughout the codebase point directly to the module containing each symbol. The re-exports still exist but nothing uses them. Module B now imports directly from module C instead of going through module A's re-export.

Type-checking should pass since we're only changing import paths without modifying any logic. Commit after successful application.

## Phase 3: Cleaning Up with propose-purge-reexport

The `propose-purge-reexport` command identifies re-exports that no longer have any importers and proposes removing them. This phase completes the refactoring by removing the temporary scaffolding that enabled safe incremental changes.

```bash
npx tsx src/tslor.ts propose-purge-reexport /path/to/directory
npx tsx src/tslor.ts apply --verify 'npm test'
```

The command scans for re-export statements and checks whether any module imports those re-exported symbols. If nothing imports a re-export, it proposes removing it. See `findUnusedReExports()` in `src/runProposePurgeReexport.ts` for the usage analysis.

After applying, the source module no longer contains re-exports. The codebase is clean—symbols live in their proper locations and imports point directly to those locations. Use full test verification for this final phase since we're removing code.

Verify the cycle is resolved by running the `cycles` command again. It should report no cycles or show that the specific cycle you targeted no longer exists.

## Complete Example: Shared Type Cycle

Consider two modules that both use `SharedType`, creating a cycle. Module A defines `SharedType` and imports `processData` from module B. Module B imports `SharedType` from module A and imports `helperFunction` from module A. This creates the cycle A ↔ B.

Analysis determines we should extract `SharedType` to a new `shared.ts` module since both modules need it. This follows the shared code pattern.

### Phase 1: Extract SharedType

```bash
npx tsx src/tslor.ts propose-split moduleA.ts shared.ts SharedType
```

The propose command displays that `shared.ts` will be created with the `SharedType` definition. Module A will have the definition removed and replaced with `export { SharedType } from './shared'`. Module B's imports remain unchanged—it still imports `SharedType` from module A, but module A now re-exports it.

```bash
npx tsx src/tslor.ts apply --verify 'tsc --noEmit'
git commit -m "Phase 1: Extract SharedType to break cycle"
```

The cycle is broken. Module B → module A → shared.ts contains no circular path.

### Phase 2: Update Imports

```bash
npx tsx src/tslor.ts propose-import-directly .
```

The propose command displays that module A will import `SharedType` from `./shared` directly. Module B will import `SharedType` from `./shared` instead of from module A. Both modules now import directly from `shared.ts`.

```bash
npx tsx src/tslor.ts apply --verify 'tsc --noEmit'
git commit -m "Phase 2: Update imports to use shared.ts directly"
```

The re-export in module A is now unused—nothing imports `SharedType` from module A anymore.

### Phase 3: Remove Re-export

```bash
npx tsx src/tslor.ts propose-purge-reexport .
```

The propose command displays that the `export { SharedType } from './shared'` line will be removed from module A.

```bash
npx tsx src/tslor.ts apply --verify 'npm test'
git commit -m "Phase 3: Remove unused re-export"
```

The refactoring is complete. Module A and module B both import `SharedType` from `shared.ts`. Module A still imports `processData` from module B. Module B still imports `helperFunction` from module A. But no cycle exists because `shared.ts` imports nothing from either module.

Verify with `npx tsx src/tslor.ts cycles .` which reports no cycles found.

## Handling Verification Failures

When `apply --verify` rolls back changes, examine the verification command output to determine whether the failure relates to your refactoring or represents a pre-existing issue. Run the verification command manually before starting any refactoring to establish a baseline.

If tests or type-checking failed before the refactoring, fix those issues first or use a different verification command. Choose verification appropriate to each phase's risk level. Phases 1 and 2 move code and change import paths without altering logic, so type-checking suffices. Phase 3 removes code, warranting full test verification if your project has tests.

If verification passes before the refactoring but fails after applying a proposed plan, this indicates a bug in TSLOR. All proposed plans should be behavior-preserving—verification failures after applying represent tool defects, not user errors. When this occurs:

1. The automatic rollback restores your codebase to its pre-apply state
2. Document the failure in a markdown file including:
   - The exact propose command used
   - The verification command that failed
   - The complete error output
   - The version of TSLOR
   - Any relevant context about the codebase structure
3. Halt the cycle resolution procedure—do not attempt workarounds or continue with other cycles

The automatic rollback on verification failure protects your codebase, but bugs should be fixed in the tool rather than worked around in individual codebases.

Checksum validation failures mean files changed since the plan was created. Regenerate the plan with current file state. Only use `apply --force` when you're certain the changes are compatible—the checksums exist to prevent applying stale plans to modified code.

## Working with Multiple Cycles

Resolve one cycle completely through all three phases before starting another. This approach maintains a clean git history and makes it easy to identify which cycle resolution caused any unexpected issues. Each phase creates a logical checkpoint suitable for committing.

For codebases with many cycles, prioritize based on impact and complexity. Cycles in foundational modules that many other modules import often have the widest impact. Simple two-module cycles provide practice before tackling complex multi-module cycles. Cycles causing runtime initialization problems take precedence over architectural improvements.

Work incrementally over days or weeks for large refactorings. The propose/apply pattern with verification ensures safety at every step, enabling pause and resume workflows. Complete one cycle, commit the three phases, and continue when time permits.

## Troubleshooting Common Issues

**Plan file does not exist**: Run a `propose-*` command first to create the plan, then run `apply`.

**Checksum validation failed**: Files changed since plan creation. Regenerate the plan with `propose-split` using current file state. Use `--force` only when certain the changes are compatible.

**Verification command fails after applying**: This indicates a bug in TSLOR since all plans should be behavior-preserving. The automatic rollback restores your codebase to its previous state. Document the failure in a markdown file including the exact propose command, verification command, complete error output, TSLOR version, and relevant context. Halt the cycle resolution procedure—do not attempt workarounds or continue with other cycles.

**propose-split moves unexpected symbols**: The command includes transitive dependencies automatically. Review the displayed diff to see what's moving. Extract fewer symbols initially or break into multiple splits if too much moves together.

**Cycle remains after three phases**: Run `cycles` with visualization to understand the remaining cycle structure. It may be a different cycle than before, or the original cycle had multiple causes requiring additional splits.

**propose-import-directly proposes nothing**: Normal after phase 1—the re-exports are intentional and being used. Continue with phase 2 to update the imports.

**propose-purge-reexport proposes nothing**: Phase 2 may not be complete yet. Some imports may still use the re-exports. Use the `imports` command to find which modules import from the module with re-exports.

**Cannot move all exported symbols**: The command prevents emptying a module. If you want to move all symbols, use the `mv` command to move the entire file instead of splitting it.
