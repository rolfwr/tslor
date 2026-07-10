import { assert, describe, test } from 'vitest';
import {
  InMemoryFileSystem,
  readTransformableFile,
  reconstructFileContent,
} from './filesystem';

/*
  Locks down the raw-vs-extracted-content contract for `.vue` files: a
  checksum or reinsert must operate on the raw SFC, never the extracted
  <script> block. This exact confusion was independently reintroduced and
  hand-fixed in four different commands before these helpers existed.
*/
describe('readTransformableFile / reconstructFileContent', () => {
  test('non-.vue file: scriptContent and rawContent are the same text, read once', async () => {
    const fs = new InMemoryFileSystem(
      new Map([['/src/foo.ts', 'export const x = 1;\n']]),
    );
    const { scriptContent, rawContent } = await readTransformableFile(
      fs,
      '/src/foo.ts',
    );
    assert.strictEqual(scriptContent, 'export const x = 1;\n');
    assert.strictEqual(rawContent, 'export const x = 1;\n');

    const finalContent = reconstructFileContent(
      '/src/foo.ts',
      rawContent,
      'export const x = 2;\n',
    );
    assert.strictEqual(finalContent, 'export const x = 2;\n');
  });

  test('.vue file: scriptContent is the extracted script, rawContent is the full SFC', async () => {
    const sfc =
      '<template><div/></template>\n<script>\nexport const x = 1;\n</script>\n<style></style>\n';
    const fs = new InMemoryFileSystem(new Map([['/src/Foo.vue', sfc]]));
    const { scriptContent, rawContent } = await readTransformableFile(
      fs,
      '/src/Foo.vue',
    );
    assert.strictEqual(scriptContent, '\nexport const x = 1;\n');
    assert.strictEqual(rawContent, sfc);

    const finalContent = reconstructFileContent(
      '/src/Foo.vue',
      rawContent,
      '\nexport const x = 2;\n',
    );
    assert.strictEqual(
      finalContent,
      '<template><div/></template>\n<script>\nexport const x = 2;\n</script>\n<style></style>\n',
    );
  });
});
