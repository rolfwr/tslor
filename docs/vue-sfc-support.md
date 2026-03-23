# Transparent Vue Single File Component Support

TSLOR provides transparent support for Vue Single File Components through a filesystem transformation layer. All refactoring and analysis commands work identically with `.vue` and `.ts` files without any special handling in command logic.

## Implementation Through Filesystem Transformation

Vue SFC support is implemented entirely through the `TransformingFileSystem` class in `src/transformingFileSystem.ts`, which implements ts-morph's `FileSystemHost` interface. The transformation pipeline identifies `.vue` files by extension, extracts TypeScript from `<script>` tags through `extractScript()`, lets ts-morph process pure TypeScript unaware it came from a Vue file, reinjects modified TypeScript back into the original Vue structure through `reinsertScript()`, making all TSLOR commands work identically with `.vue` and `.ts` files.

When TSLOR moves `UserService` from a User.vue component to a new file, it sees and modifies only the TypeScript content (the import statement), then automatically reinjects it back into the Vue SFC. The Vue template and other sections remain completely unchanged.

This design requires zero changes to refactoring logic for Vue support, zero changes to dependency analysis for Vue support, and zero changes to indexing logic for Vue support. All logic remains in one place: `transformingFileSystem.ts`.

## TransformingFileSystem Implementation

The class in `src/transformingFileSystem.ts` implements the `FileSystemHost` interface from ts-morph, intercepts all file read and write operations, and transforms Vue files to and from pure TypeScript transparently.

The `readFileSync(path)` method extracts `<script>` content and returns as TypeScript for `.vue` files, or passes through unchanged for `.ts` files. The `writeFileSync(path, content)` method parses existing Vue files, replaces `<script>` content while preserving everything else for `.vue` files, or passes through unchanged for `.ts` files. The `extractScript()` function implementation parses Vue SFCs, finds `<script>` or `<script lang="ts">` tags, extracts and returns content, or returns empty string if no script block exists. The `reinsertScript()` function parses Vue SFCs, finds `<script>` tags, replaces content while preserving attributes and indentation, and returns the modified Vue file.

## What's Supported and What's Not

Supported features include `<script lang="ts">` blocks, standard `<script>` blocks (assumed TypeScript), import and export statements, type annotations, and interface or type definitions.

Not yet supported features include `<script setup>` syntax, template dependencies computed from `<template>` section, style dependencies from imports in `<style>` section, and multiple `<script>` blocks.

## Using Vue Files with TSLOR

No special syntax needed—use `.vue` files just like `.ts` files with all commands. Extract from Vue components, move Vue components, analyze Vue dependencies, and find who imports Vue components all using the same commands as TypeScript files.

The transparent filesystem layer is tested through integration tests using real Vue SFCs, unit tests for `extractScript()` and `reinsertScript()` functions in `src/transformingFileSystem.test.ts`, and verification that refactoring operations work identically on `.vue` and `.ts` files.

Potential future enhancements include supporting `<script setup>` syntax, analyzing template dependencies, tracking style block imports, and better preserving formatting in script blocks.
