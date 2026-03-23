# Propose/Apply Pattern for Safe Refactoring

TSLOR adopts a propose/apply pattern for safe, reviewable refactorings inspired by infrastructure-as-code tools.

## Problems with Traditional --dry-run Flags

Traditional `--dry-run` flags suffer from code duplication between dry-run and execution logic, divergence risk where dry-run output doesn't match actual execution, no review artifact since output is ephemeral, and limited validation before execution.

## Benefits of Propose/Apply

The propose/apply pattern provides a single source of truth where the plan file is the execution contract, guaranteed accuracy where what's proposed is exactly what will be applied, reviewability through committable plan files that can be shared, auditability through historical records of changes, safety through an explicit two-step process preventing accidents, and CI/CD friendliness by separating propose (in CI) from apply (manual gate).

## How It Works

The propose phase generates `.tslor-plan.json` without modifying source files, containing all file operations (create, modify, delete), SHA256 checksums of affected files, and full undo information for rollback. Review examines the plan through unified diff preview, file name listing, or committing for team review. The apply phase executes the plan atomically by validating the plan exists and is well-formed, checking SHA256 checksums match current files (unless `--force` is used), applying all changes atomically, running optional verification commands, automatically rolling back if verification fails, and archiving the plan as `.applied-{timestamp}.json`.

## Plan File Structure

The `TslorPlan` interface in `src/plan.ts` defines the plan structure with version for plan format, command that created the plan, ISO 8601 timestamp, list of all affected files, checksums mapping file paths to SHA256 hashes of content, array of change operations to perform, and optional undo information for rollback. Change types include create with path and content, modify with path and content, and delete with path only.

## Safety Mechanisms

Checksum validation prevents applying stale plans to modified code by computing SHA256 for all affected files during propose, verifying during apply and failing if files changed, with optional override using `--force` if intentional. Automatic rollback uses undo information from the plan to restore files to pre-apply state if verification fails, ensuring no partial refactorings are left behind. The audit trail archives every applied plan with timestamp as `.applied-{timestamp}.json`, providing a permanent record of refactorings for reviewing historical changes.

## Team Workflows

Code review flow has developers create plans on branches, commit the plan file for review in pull requests, and after approval apply the plan with verification. The implementation in `src/runProposeSplit.ts` and `src/runApply.ts` handles the workflow mechanics.

CI/CD integration can run propose in CI to validate refactorings before merge, check plan files exist and preview diffs, or add custom validation rules specific to the project.

## Comparison with Alternatives

Compared to --dry-run flags, propose/apply guarantees accuracy through the same code path while --dry-run risks divergence. Propose/apply provides committable artifacts for review while --dry-run produces ephemeral output. Propose/apply offers checksum verification while --dry-run has none. Propose/apply enables automatic rollback while --dry-run requires manual intervention. Propose/apply archives plans for audit while --dry-run keeps no record.

Compared to direct execution, propose/apply adds safety through an explicit review step while maintaining execution efficiency through atomic operations.
