import { assert, describe, it } from 'vitest';
import { InMemoryFileSystem } from './filesystem';
import { loadSourceFile, loadSourceFileForAnalysis } from './loadSourceFile';
import { parseModule } from './staticAnalysis';

describe('loadSourceFile', () => {
  it('allows binder-backed APIs without crashing', async () => {
    const fileSystem = new InMemoryFileSystem(
      new Map([
        ['/project/src/test.ts', 'const x = 1;'],
      ]),
    );

    const sourceFile = await loadSourceFile(
      '/project/src/test.ts',
      fileSystem,
    );

    // getLocals() triggers binder → lazy ts.Program creation → fs probes.
    // This must not throw.
    const locals = sourceFile.getLocals();

    // 'x' is bound in the loaded source — verifies the file content was parsed.
    assert(locals.map((s) => s.getName()).includes('x'));
  });
});

describe('loadSourceFileForAnalysis', () => {
  it('extracts the <script> block from .vue files', async () => {
    /*
      A .vue file is a single-file component whose non-script sections
      (<template>, <style>) are not TypeScript. Feeding the raw SFC to the
      parser mis-parses those sections and corrupts the import declarations —
      the module specifier goes missing and parseModule throws. The loader
      must extract the <script> block, mirroring TransformingFileSystem.
    */
    const vue = [
      '<template>',
      '  <div>{{ label }}</div>',
      '</template>',
      '<script lang="ts">',
      `import { helper } from './helper';`,
      'export const label = helper();',
      '</script>',
    ].join('\n');

    const fileSystem = new InMemoryFileSystem(
      new Map([['/project/src/Comp.vue', vue]]),
    );

    const sourceFile = await loadSourceFileForAnalysis(
      '/project/src/Comp.vue',
      fileSystem,
    );

    assert(!sourceFile.getFullText().includes('<template>'));

    const info = parseModule(sourceFile);
    assert.strictEqual(info.imports[0]?.moduleSpec, './helper');
  });

  it('does not pull lib.d.ts into the per-module analysis program', async () => {
    /*
      loadSourceFileForAnalysis runs once per file during repo-wide indexing.
      Dropping skipLoadingLibFiles makes the first binder call parse the bundled
      lib.d.ts set (~7 files) into this per-module program — ~51ms/file vs
      ~0.35ms/file — which shipped as a regression that made indexing hang.
      getLocals() reads only module-scope locals, so lib files never change the
      result; the pull-in is visible only in the underlying ts.Program
      (ts-morph's own getSourceFiles() reports 1 either way).
    */
    const fileSystem = new InMemoryFileSystem(
      new Map([['/project/src/test.ts', 'const x = 1;']]),
    );

    const sourceFile = await loadSourceFileForAnalysis(
      '/project/src/test.ts',
      fileSystem,
    );

    // Force the binder to create the underlying ts.Program.
    sourceFile.getLocals();

    const programFiles = sourceFile
      .getProject()
      .getProgram()
      .compilerObject.getSourceFiles();
    assert.strictEqual(programFiles.length, 1);
  });
});
