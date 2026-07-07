import { relative, join } from 'path';
import { assert, describe, test } from 'vitest';
import { createTempDir } from './testUtils';
import { resolveCommandScope } from './commandScope';
import { RealFileSystem } from './filesystem';

describe('resolveCommandScope', () => {
  test('file-only input returns normalized paths', async () => {
    const { dir, cleanup } = createTempDir({
      files: {
        'a.ts': 'export const a = 1;',
        'b.ts': 'export const b = 2;',
      },
    });
    try {
      const result = await resolveCommandScope(
        [join(dir, 'a.ts'), join(dir, 'b.ts')],
        new RealFileSystem(),
      );

      assert.equal(result.size, 2);
      assert.isTrue(result.has(join(dir, 'a.ts')));
      assert.isTrue(result.has(join(dir, 'b.ts')));
    } finally {
      cleanup();
    }
  });

  test('directory-only input expands to TypeScript files', async () => {
    const { dir, cleanup } = createTempDir({
      files: {
        'a.ts': 'export const a = 1;',
        'b.ts': 'export const b = 2;',
        'c.js': 'not typescript',
        'readme.md': 'not typescript',
      },
    });
    try {
      const result = await resolveCommandScope([dir], new RealFileSystem());

      assert.equal(result.size, 2);
      assert.isTrue(result.has(join(dir, 'a.ts')));
      assert.isTrue(result.has(join(dir, 'b.ts')));
      assert.isFalse(result.has(join(dir, 'c.js')));
    } finally {
      cleanup();
    }
  });

  test('mixed input combines files and directory expansion', async () => {
    const { dir, cleanup } = createTempDir({
      files: {
        'a.ts': 'export const a = 1;',
        'sub/b.ts': 'export const b = 2;',
        'sub/c.ts': 'export const c = 3;',
      },
    });
    try {
      const result = await resolveCommandScope(
        [join(dir, 'a.ts'), join(dir, 'sub')],
        new RealFileSystem(),
      );

      assert.equal(result.size, 3);
      assert.isTrue(result.has(join(dir, 'a.ts')));
      assert.isTrue(result.has(join(dir, 'sub', 'b.ts')));
      assert.isTrue(result.has(join(dir, 'sub', 'c.ts')));
    } finally {
      cleanup();
    }
  });

  test('deduplicates files reachable via direct path and directory expansion', async () => {
    const { dir, cleanup } = createTempDir({
      files: {
        'a.ts': 'export const a = 1;',
        'b.ts': 'export const b = 2;',
      },
    });
    try {
      const result = await resolveCommandScope(
        [join(dir, 'a.ts'), dir],
        new RealFileSystem(),
      );

      assert.equal(result.size, 2);
      assert.isTrue(result.has(join(dir, 'a.ts')));
      assert.isTrue(result.has(join(dir, 'b.ts')));
    } finally {
      cleanup();
    }
  });

  test('empty directory contributes no files', async () => {
    const { dir, cleanup } = createTempDir();
    try {
      const result = await resolveCommandScope([dir], new RealFileSystem());

      assert.equal(result.size, 0);
    } finally {
      cleanup();
    }
  });

  test('skips node_modules, dot-prefixed, and underscore-prefixed directories', async () => {
    const { dir, cleanup } = createTempDir({
      files: {
        'a.ts': 'export const a = 1;',
        'node_modules/lib.ts': 'should be skipped',
        '.hidden/secret.ts': 'should be skipped',
        '_internal/private.ts': 'should be skipped',
      },
    });
    try {
      const result = await resolveCommandScope([dir], new RealFileSystem());

      assert.equal(result.size, 1);
      assert.isTrue(result.has(join(dir, 'a.ts')));
    } finally {
      cleanup();
    }
  });

  test('includes .vue files in directory expansion', async () => {
    const { dir, cleanup } = createTempDir({
      files: {
        'component.vue': '<template></template>',
        'util.ts': 'export const util = 1;',
      },
    });
    try {
      const result = await resolveCommandScope([dir], new RealFileSystem());

      assert.equal(result.size, 2);
      assert.isTrue(result.has(join(dir, 'component.vue')));
      assert.isTrue(result.has(join(dir, 'util.ts')));
    } finally {
      cleanup();
    }
  });

  test('relative paths are resolved to absolute', async () => {
    const { dir, cleanup } = createTempDir({
      files: {
        'a.ts': 'export const a = 1;',
      },
    });
    try {
      /*
        Compute a relative path from cwd to the temp dir so we actually test
        relative path resolution. normalizePath() uses path.resolve() which
        resolves relative paths against process.cwd().
      */
      const relativeDir = relative(process.cwd(), dir);
      const result = await resolveCommandScope(
        [relativeDir],
        new RealFileSystem(),
      );

      for (const path of result) {
        assert.isTrue(path.startsWith('/'), `Path ${path} should be absolute`);
      }
    } finally {
      cleanup();
    }
  });
});
