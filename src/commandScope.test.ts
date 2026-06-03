import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { assert, describe, test, afterEach } from "vitest";
import { resolveCommandScope } from "./commandScope";
import { RealFileSystem } from "./filesystem";

/*
  createTempDir creates a temporary directory on disk and populates it with
  the given file structure. Returns the absolute path to the directory and
  a cleanup function.

  files is a map from relative path (e.g. "a.ts") to content.
  Subdirectories are created automatically from the path segments.
*/
async function createTempDir(
  files: Record<string, string>
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `tslor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    await mkdir(parentDir, { recursive: true });
    await writeFile(fullPath, content);
  }

  const cleanup = async () => rm(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

describe("resolveCommandScope", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  async function setup(files: Record<string, string>) {
    const { dir, cleanup } = await createTempDir(files);
    cleanups.push(cleanup);
    return dir;
  }

  test("file-only input returns normalized paths", async () => {
    const dir = await setup({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });

    const result = await resolveCommandScope(
      [join(dir, "a.ts"), join(dir, "b.ts")],
      new RealFileSystem()
    );

    assert.equal(result.size, 2);
    assert.isTrue(result.has(join(dir, "a.ts")));
    assert.isTrue(result.has(join(dir, "b.ts")));
  });

  test("directory-only input expands to TypeScript files", async () => {
    const dir = await setup({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
      "c.js": "not typescript",
      "readme.md": "not typescript",
    });

    const result = await resolveCommandScope([dir], new RealFileSystem());

    assert.equal(result.size, 2);
    assert.isTrue(result.has(join(dir, "a.ts")));
    assert.isTrue(result.has(join(dir, "b.ts")));
    assert.isFalse(result.has(join(dir, "c.js")));
  });

  test("mixed input combines files and directory expansion", async () => {
    const dir = await setup({
      "a.ts": "export const a = 1;",
      "sub/b.ts": "export const b = 2;",
      "sub/c.ts": "export const c = 3;",
    });

    const result = await resolveCommandScope(
      [join(dir, "a.ts"), join(dir, "sub")],
      new RealFileSystem()
    );

    assert.equal(result.size, 3);
    assert.isTrue(result.has(join(dir, "a.ts")));
    assert.isTrue(result.has(join(dir, "sub", "b.ts")));
    assert.isTrue(result.has(join(dir, "sub", "c.ts")));
  });

  test("deduplicates files reachable via direct path and directory expansion", async () => {
    const dir = await setup({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });

    const result = await resolveCommandScope(
      [join(dir, "a.ts"), dir],
      new RealFileSystem()
    );

    assert.equal(result.size, 2);
    assert.isTrue(result.has(join(dir, "a.ts")));
    assert.isTrue(result.has(join(dir, "b.ts")));
  });

  test("empty directory contributes no files", async () => {
    const { dir, cleanup } = await createTempDir({});
    cleanups.push(cleanup);

    const result = await resolveCommandScope([dir], new RealFileSystem());

    assert.equal(result.size, 0);
  });

  test("skips node_modules and dot-prefixed directories", async () => {
    const dir = await setup({
      "a.ts": "export const a = 1;",
      "node_modules/lib.ts": "should be skipped",
      ".hidden/secret.ts": "should be skipped",
      "_internal/private.ts": "should be skipped",
    });

    const result = await resolveCommandScope([dir], new RealFileSystem());

    assert.equal(result.size, 1);
    assert.isTrue(result.has(join(dir, "a.ts")));
  });

  test("includes .vue files in directory expansion", async () => {
    const dir = await setup({
      "component.vue": "<template></template>",
      "util.ts": "export const util = 1;",
    });

    const result = await resolveCommandScope([dir], new RealFileSystem());

    assert.equal(result.size, 2);
    assert.isTrue(result.has(join(dir, "component.vue")));
    assert.isTrue(result.has(join(dir, "util.ts")));
  });

  test("relative paths are resolved to absolute", async () => {
    const dir = await setup({
      "a.ts": "export const a = 1;",
    });

    const result = await resolveCommandScope([dir], new RealFileSystem());

    for (const path of result) {
      assert.isTrue(
        path.startsWith("/"),
        `Path ${path} should be absolute`
      );
    }
  });
});
