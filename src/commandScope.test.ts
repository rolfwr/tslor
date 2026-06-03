import { mkdir, writeFile, rm } from "fs/promises";
import { dirname, join, relative } from "path";
import { tmpdir } from "os";
import { assert, describe, test } from "vitest";
import { resolveCommandScope } from "./commandScope";
import { RealFileSystem } from "./filesystem";

/**
 * Create a temporary directory on disk and populate it with the given file
 * structure. Returns the absolute path to the directory and a cleanup function.
 *
 * files is a map from relative path (e.g. "a.ts") to content.
 * Subdirectories are created automatically from the path segments.
 */
async function createTempDir(
  files: Record<string, string>
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `tslor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    const parentDir = dirname(fullPath);
    await mkdir(parentDir, { recursive: true });
    await writeFile(fullPath, content);
  }

  const cleanup = async () => rm(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

describe("resolveCommandScope", () => {
  test("file-only input returns normalized paths", async () => {
    const { dir, cleanup } = await createTempDir({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    try {
      const result = await resolveCommandScope(
        [join(dir, "a.ts"), join(dir, "b.ts")],
        new RealFileSystem()
      );

      assert.equal(result.size, 2);
      assert.isTrue(result.has(join(dir, "a.ts")));
      assert.isTrue(result.has(join(dir, "b.ts")));
    } finally {
      await cleanup();
    }
  });

  test("directory-only input expands to TypeScript files", async () => {
    const { dir, cleanup } = await createTempDir({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
      "c.js": "not typescript",
      "readme.md": "not typescript",
    });
    try {
      const result = await resolveCommandScope([dir], new RealFileSystem());

      assert.equal(result.size, 2);
      assert.isTrue(result.has(join(dir, "a.ts")));
      assert.isTrue(result.has(join(dir, "b.ts")));
      assert.isFalse(result.has(join(dir, "c.js")));
    } finally {
      await cleanup();
    }
  });

  test("mixed input combines files and directory expansion", async () => {
    const { dir, cleanup } = await createTempDir({
      "a.ts": "export const a = 1;",
      "sub/b.ts": "export const b = 2;",
      "sub/c.ts": "export const c = 3;",
    });
    try {
      const result = await resolveCommandScope(
        [join(dir, "a.ts"), join(dir, "sub")],
        new RealFileSystem()
      );

      assert.equal(result.size, 3);
      assert.isTrue(result.has(join(dir, "a.ts")));
      assert.isTrue(result.has(join(dir, "sub", "b.ts")));
      assert.isTrue(result.has(join(dir, "sub", "c.ts")));
    } finally {
      await cleanup();
    }
  });

  test("deduplicates files reachable via direct path and directory expansion", async () => {
    const { dir, cleanup } = await createTempDir({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    try {
      const result = await resolveCommandScope(
        [join(dir, "a.ts"), dir],
        new RealFileSystem()
      );

      assert.equal(result.size, 2);
      assert.isTrue(result.has(join(dir, "a.ts")));
      assert.isTrue(result.has(join(dir, "b.ts")));
    } finally {
      await cleanup();
    }
  });

  test("empty directory contributes no files", async () => {
    const { dir, cleanup } = await createTempDir({});
    try {
      const result = await resolveCommandScope([dir], new RealFileSystem());

      assert.equal(result.size, 0);
    } finally {
      await cleanup();
    }
  });

  test("skips node_modules, dot-prefixed, and underscore-prefixed directories", async () => {
    const { dir, cleanup } = await createTempDir({
      "a.ts": "export const a = 1;",
      "node_modules/lib.ts": "should be skipped",
      ".hidden/secret.ts": "should be skipped",
      "_internal/private.ts": "should be skipped",
    });
    try {
      const result = await resolveCommandScope([dir], new RealFileSystem());

      assert.equal(result.size, 1);
      assert.isTrue(result.has(join(dir, "a.ts")));
    } finally {
      await cleanup();
    }
  });

  test("includes .vue files in directory expansion", async () => {
    const { dir, cleanup } = await createTempDir({
      "component.vue": "<template></template>",
      "util.ts": "export const util = 1;",
    });
    try {
      const result = await resolveCommandScope([dir], new RealFileSystem());

      assert.equal(result.size, 2);
      assert.isTrue(result.has(join(dir, "component.vue")));
      assert.isTrue(result.has(join(dir, "util.ts")));
    } finally {
      await cleanup();
    }
  });

  test("relative paths are resolved to absolute", async () => {
    const { dir, cleanup } = await createTempDir({
      "a.ts": "export const a = 1;",
    });
    try {
      /*
        Compute a relative path from cwd to the temp dir so we actually test
        relative path resolution. normalizePath() uses path.resolve() which
        resolves relative paths against process.cwd().
      */
      const relativeDir = relative(process.cwd(), dir);
      const result = await resolveCommandScope([relativeDir], new RealFileSystem());

      for (const path of result) {
        assert.isTrue(
          path.startsWith("/"),
          `Path ${path} should be absolute`
        );
      }
    } finally {
      await cleanup();
    }
  });
});
