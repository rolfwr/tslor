# Composable Refactoring Philosophy

TSLOR follows the Unix philosophy: "do one thing and do it well." Each command performs a focused operation. Complex refactorings are achieved by chaining simple commands rather than building monolithic tools.

## Intentional Re-exports for Safety

The `split` command creates re-exports by design, not as a limitation. This prioritizes safety over perfection by moving requested symbols and their dependencies to a new module, creating re-exports in the source module for backward compatibility, and leaving all import sites unchanged. This ensures the split operation never breaks existing code, only two files are modified (source and target), verification of the split itself is straightforward, and rollback is simple if something goes wrong.

## Cleanup Through Separate Commands

After split creates re-exports, future commands will handle cleanup. The workflow proposes a split, applies with verification, then proposes updating import sites (future command), applies with verification, proposes removing unused re-exports (future command), and applies with verification. Each step uses the `--verify` flag to run project-specific validation commands like `npm test` or `tsc --noEmit`.

## Why Composability Matters

Verification between steps happens through the `--verify` flag running project-specific validation after applying changes. If verification fails, changes are automatically rolled back. Incremental refactoring allows large codebases to be updated gradually over days or weeks, updating some import sites now and others later. Rollback-friendly design means if verification fails, automatic rollback restores files to pre-apply state with only one operation needing reverting. Clear intent comes from each command's obvious purpose without mega-commands requiring dozens of flags to understand. Easier implementation results from each command having fewer edge cases to handle, making simpler code more reliable.

## Avoiding Monolithic Commands

A monolithic anti-pattern would attempt everything in one shot with many flags: splitting, updating all imports, removing re-exports, cleaning unused code, optimizing imports, and formatting. If this fails, determining what broke becomes difficult.

Instead, TSLOR recommends one operation at a time with verification. Propose the split and apply with verification. Propose replacing re-exports (future command) and apply with verification. Propose cleaning re-exports (future command) and apply with verification. Each step validates independently.

## Command Ecosystem

Current refactoring commands include `propose-split` and `split` for extracting symbols with re-exports for safety, `apply` for executing plans with optional `--verify` command, and `mv` for moving entire files and updating imports. Current analysis commands include `hot` for finding bottleneck modules, `cycles` for detecting circular dependencies, `dependencies` for listing transitive dependencies, `imports` for finding who imports a module, and `grep` for fast symbol search.

Proposed commands for import management would generate plans to update imports to direct imports, remove unused re-exports, convert complex imports to simple patterns, and merge multiple imports from same module. Proposed commands for dead code detection would show exported symbols not imported anywhere and find re-exports nothing imports. Additional proposed refactoring commands would generate plans to move symbols back (opposite of split) and extract duplicated code to shared modules.

## Why Not Update All Import Sites Immediately

Updating all importers immediately would change potentially hundreds of files, make it hard to verify the split itself worked, increase risk of breaking something, and be harder to rollback if problems are found. By creating re-exports, the split is isolated to only two files changing, verification can confirm the split itself worked, import sites can be updated separately, and each step can be verified independently.

## Example Workflow: Cleaning Up a Monolithic Module

Consider a monolithic 500-line `utils.ts` file containing `formatDate()`, `parseDate()`, `fetchUser()`, `validateEmail()`, and 50 more mixed functions. Step-by-step cleanup with verification would propose splitting date utilities and apply with type-checking verification, propose splitting user utilities and apply with type-checking, then propose splitting validation utilities and apply with full test verification. At each step automatic verification and rollback handles failures, making it easy to identify which step failed.

After all splits complete, optional cleanup could propose replacing re-exports for `formatDate`, apply with type-checking, propose replacing re-exports for `parseDate`, apply with tests, and so on. Finally propose cleaning unused re-exports from `utils.ts` and apply with tests.

This composable command approach enables building complex refactorings from simple, reliable primitives. Safety through re-exports is a feature, not a bug—it's how TSLOR maintains behavior preservation while enabling large-scale refactorings. The propose/apply pattern with `--verify` ensures each step can be independently validated and automatically rolled back on failure.
