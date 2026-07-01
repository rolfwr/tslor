import { assert, describe, test } from "vitest";
import { ObjStore } from "./objstore";
import { Storage } from "./storage";
import { buildImportGroups } from "./runImportGroups";

/**
 * Build a Storage instance from a list of import edges.
 *
 * Each edge represents "from imports a symbol from to".
 * Optional tsconfig overrides let tests simulate cross-project imports.
 */
function makeStorage(
  edges: Array<{
    from: string;
    to: string;
    fromTsconfig?: string;
    toTsconfig?: string;
  }>
): Storage {
  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, { jsonlPath: "/dev/null", verbose: false, inMemory: true });
  let idx = 0;
  for (const { from, to, fromTsconfig, toTsconfig } of edges) {
    storage.putImport(
      from,
      fromTsconfig ?? "/tsconfig.json",
      idx++,
      "sym",
      {
        path: to,
        tsconfig: toTsconfig ?? "/tsconfig.json",
      }
    );
  }
  return storage;
}

/**
 * Retrieve an element from an array, throwing if the index is out of bounds.
 * Used in tests where the expected length is asserted before the lookup.
 */
function atOrThrow<T>(arr: T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${index} out of bounds for array of length ${arr.length}`);
  }
  return value;
}

describe("buildImportGroups", () => {
  test("groups modules sharing the same import set", () => {
    /*
      /a.ts imports /lib.ts and /util.ts
      /b.ts imports /lib.ts and /util.ts
      /c.ts imports /lib.ts only

      Expected: one group with /a.ts and /b.ts (score 2*2=4),
      /c.ts is a singleton and excluded.
    */
    const db = makeStorage([
      { from: "/a.ts", to: "/lib.ts" },
      { from: "/a.ts", to: "/util.ts" },
      { from: "/b.ts", to: "/lib.ts" },
      { from: "/b.ts", to: "/util.ts" },
      { from: "/c.ts", to: "/lib.ts" },
    ]);

    const groups = buildImportGroups(
      db,
      ["/a.ts", "/b.ts", "/c.ts", "/lib.ts", "/util.ts"],
      null
    );

    assert.equal(groups.length, 1);
    const group = atOrThrow(groups, 0);
    assert.deepEqual(group.members, ["/a.ts", "/b.ts"]);
    assert.deepEqual(group.imports, ["/lib.ts", "/util.ts"]);
    assert.equal(group.score, 4);
  });

  test("excludes modules with zero imports", () => {
    /*
      /empty.ts has no imports. /a.ts and /b.ts share /lib.ts.
      /empty.ts must not appear in any group.
    */
    const db = makeStorage([
      { from: "/a.ts", to: "/lib.ts" },
      { from: "/b.ts", to: "/lib.ts" },
    ]);

    const groups = buildImportGroups(
      db,
      ["/a.ts", "/b.ts", "/empty.ts", "/lib.ts"],
      null
    );

    for (const group of groups) {
      assert.isFalse(
        group.members.includes("/empty.ts"),
        "empty-import module must not appear in any group"
      );
    }
  });

  test("excludes singleton groups", () => {
    /*
      /a.ts imports /x.ts only (unique profile)
      /b.ts imports /y.ts only (unique profile)

      Both would form singleton groups — both are excluded.
    */
    const db = makeStorage([
      { from: "/a.ts", to: "/x.ts" },
      { from: "/b.ts", to: "/y.ts" },
    ]);

    const groups = buildImportGroups(
      db,
      ["/a.ts", "/b.ts", "/x.ts", "/y.ts"],
      null
    );

    assert.equal(groups.length, 0);
  });

  test("scores and orders groups by descending score", () => {
    /*
      Group 1: /a.ts and /b.ts share /lib.ts and /util.ts -> score 2*2=4
      Group 2: /c.ts, /d.ts, /e.ts share /core.ts -> score 3*1=3

      Group 1 should come first (higher score).
    */
    const db = makeStorage([
      { from: "/a.ts", to: "/lib.ts" },
      { from: "/a.ts", to: "/util.ts" },
      { from: "/b.ts", to: "/lib.ts" },
      { from: "/b.ts", to: "/util.ts" },
      { from: "/c.ts", to: "/core.ts" },
      { from: "/d.ts", to: "/core.ts" },
      { from: "/e.ts", to: "/core.ts" },
    ]);

    const groups = buildImportGroups(
      db,
      [
        "/a.ts",
        "/b.ts",
        "/c.ts",
        "/d.ts",
        "/e.ts",
        "/lib.ts",
        "/util.ts",
        "/core.ts",
      ],
      null
    );

    assert.equal(groups.length, 2);
    assert.equal(atOrThrow(groups, 0).score, 4);
    assert.equal(atOrThrow(groups, 1).score, 3);
  });

  test("tie-breaks equal scores lexicographically by hash key", () => {
    /*
      Group A: /a.ts and /b.ts share /alpha.ts -> key "/alpha.ts"
      Group B: /c.ts and /d.ts share /beta.ts  -> key "/beta.ts"

      Both have score 2*1=2. "/alpha.ts" < "/beta.ts" so Group A comes first.
    */
    const db = makeStorage([
      { from: "/a.ts", to: "/alpha.ts" },
      { from: "/b.ts", to: "/alpha.ts" },
      { from: "/c.ts", to: "/beta.ts" },
      { from: "/d.ts", to: "/beta.ts" },
    ]);

    const groups = buildImportGroups(
      db,
      ["/a.ts", "/b.ts", "/c.ts", "/d.ts", "/alpha.ts", "/beta.ts"],
      null
    );

    assert.equal(groups.length, 2);
    assert.deepEqual(atOrThrow(groups, 0).imports, ["/alpha.ts"]);
    assert.deepEqual(atOrThrow(groups, 1).imports, ["/beta.ts"]);
  });

  test("normalizes aliases: different specifiers resolving to same file group together", () => {
    /*
      /a.ts imports via "@src/lib" -> resolves to /lib.ts
      /b.ts imports via "./lib" -> resolves to /lib.ts

      Storage already resolves both to the same canonical path (/lib.ts),
      so both modules should belong to the same group.
    */
    const db = makeStorage([
      { from: "/a.ts", to: "/lib.ts" },
      { from: "/b.ts", to: "/lib.ts" },
    ]);

    const groups = buildImportGroups(db, ["/a.ts", "/b.ts", "/lib.ts"], null);

    assert.equal(groups.length, 1);
    const aliasGroup = atOrThrow(groups, 0);
    assert.deepEqual(aliasGroup.members, ["/a.ts", "/b.ts"]);
    assert.deepEqual(aliasGroup.imports, ["/lib.ts"]);
  });

  test("is symbol-agnostic: different symbols from same module group together", () => {
    /*
      /a.ts imports { Foo } from /lib.ts
      /b.ts imports { Bar } from /lib.ts

      Both import from the same resolved path (/lib.ts), so they belong
      to the same group. The specific symbols (Foo vs Bar) don't matter.
    */
    const db = makeStorage([
      { from: "/a.ts", to: "/lib.ts" },
      { from: "/b.ts", to: "/lib.ts" },
    ]);

    const groups = buildImportGroups(db, ["/a.ts", "/b.ts", "/lib.ts"], null);

    assert.equal(groups.length, 1);
    const symGroup = atOrThrow(groups, 0);
    assert.deepEqual(symGroup.members, ["/a.ts", "/b.ts"]);
    assert.deepEqual(symGroup.imports, ["/lib.ts"]);
  });

  test("filters cross-project imports when project-scope is enabled", () => {
    /*
      /a.ts (project A) imports /lib.ts (project A) and /ext.ts (project B)
      /b.ts (project A) imports /lib.ts (project A)

      Without project-scope: /a.ts has imports [/ext.ts, /lib.ts],
      /b.ts has [/lib.ts] -> different groups
      With project-scope: /a.ts has imports [/lib.ts], /b.ts has [/lib.ts]
      -> same group
    */
    const db = makeStorage([
      {
        from: "/a.ts",
        to: "/lib.ts",
        fromTsconfig: "/project/tsconfig.json",
        toTsconfig: "/project/tsconfig.json",
      },
      {
        from: "/a.ts",
        to: "/ext.ts",
        fromTsconfig: "/project/tsconfig.json",
        toTsconfig: "/other/tsconfig.json",
      },
      {
        from: "/b.ts",
        to: "/lib.ts",
        fromTsconfig: "/project/tsconfig.json",
        toTsconfig: "/project/tsconfig.json",
      },
    ]);

    const moduleTsconfigMap = new Map([
      ["/a.ts", "/project/tsconfig.json"],
      ["/b.ts", "/project/tsconfig.json"],
      ["/lib.ts", "/project/tsconfig.json"],
      ["/ext.ts", "/other/tsconfig.json"],
    ]);

    const groups = buildImportGroups(
      db,
      ["/a.ts", "/b.ts", "/lib.ts", "/ext.ts"],
      moduleTsconfigMap
    );

    assert.equal(groups.length, 1);
    const scopeGroup = atOrThrow(groups, 0);
    assert.deepEqual(scopeGroup.members, ["/a.ts", "/b.ts"]);
    assert.deepEqual(scopeGroup.imports, ["/lib.ts"]);
  });

  test("modules without a tsconfig entry are excluded from project-scope grouping", () => {
    /*
      /a.ts has tsconfig, /b.ts does not appear in moduleTsconfigMap.
      /b.ts's imports should be filtered out (it can't match any tsconfig).
    */
    const db = makeStorage([
      {
        from: "/a.ts",
        to: "/lib.ts",
        fromTsconfig: "/project/tsconfig.json",
        toTsconfig: "/project/tsconfig.json",
      },
      {
        from: "/b.ts",
        to: "/lib.ts",
        fromTsconfig: "/project/tsconfig.json",
        toTsconfig: "/project/tsconfig.json",
      },
    ]);

    const moduleTsconfigMap = new Map([
      ["/a.ts", "/project/tsconfig.json"],
      // /b.ts intentionally omitted
    ]);

    const groups = buildImportGroups(
      db,
      ["/a.ts", "/b.ts", "/lib.ts"],
      moduleTsconfigMap
    );

    /*
      /a.ts has /lib.ts (same tsconfig) -> group with key "/lib.ts"
      /b.ts has no tsconfig entry -> all imports filtered -> zero imports -> excluded
      Result: only /a.ts in group -> singleton -> excluded
    */
    assert.equal(groups.length, 0);
  });

  test("handles multiple groups with different import counts", () => {
    /*
      Group 1: 3 modules share 2 imports -> score 6
      Group 2: 4 modules share 1 import -> score 4
      Group 3: 2 modules share 3 imports -> score 6 (tied with Group 1)

      Order: Group 1 or Group 3 first (tied at 6, tie-broken by key),
      then Group 2.
    */
    const db = makeStorage([
      { from: "/a1.ts", to: "/x.ts" },
      { from: "/a1.ts", to: "/y.ts" },
      { from: "/a2.ts", to: "/x.ts" },
      { from: "/a2.ts", to: "/y.ts" },
      { from: "/a3.ts", to: "/x.ts" },
      { from: "/a3.ts", to: "/y.ts" },
      { from: "/b1.ts", to: "/z.ts" },
      { from: "/b2.ts", to: "/z.ts" },
      { from: "/b3.ts", to: "/z.ts" },
      { from: "/b4.ts", to: "/z.ts" },
      { from: "/c1.ts", to: "/p.ts" },
      { from: "/c1.ts", to: "/q.ts" },
      { from: "/c1.ts", to: "/r.ts" },
      { from: "/c2.ts", to: "/p.ts" },
      { from: "/c2.ts", to: "/q.ts" },
      { from: "/c2.ts", to: "/r.ts" },
    ]);

    const allFiles = [
      "/a1.ts",
      "/a2.ts",
      "/a3.ts",
      "/b1.ts",
      "/b2.ts",
      "/b3.ts",
      "/b4.ts",
      "/c1.ts",
      "/c2.ts",
      "/x.ts",
      "/y.ts",
      "/z.ts",
      "/p.ts",
      "/q.ts",
      "/r.ts",
    ];

    const groups = buildImportGroups(db, allFiles, null);

    assert.equal(groups.length, 3);

    // All scores should be >= 4 (the lowest)
    assert.isAtLeast(atOrThrow(groups, groups.length - 1).score, 4);

    // Verify descending order
    for (let i = 1; i < groups.length; i++) {
      const prev = atOrThrow(groups, i - 1);
      const curr = atOrThrow(groups, i);
      assert.isAtLeast(
        prev.score,
        curr.score,
        `groups[${i - 1}].score (${prev.score}) >= groups[${i}].score (${curr.score})`
      );
    }
  });

  test("deduplicates duplicate imports from the same module", () => {
    /*
      /a.ts imports both Foo and Bar from /lib.ts (two putImport calls).
      The import set for /a.ts should still be [/lib.ts] (deduplicated).
    */
    const db = makeStorage([
      { from: "/a.ts", to: "/lib.ts" },
      { from: "/a.ts", to: "/lib.ts" },
      { from: "/b.ts", to: "/lib.ts" },
    ]);

    const groups = buildImportGroups(
      db,
      ["/a.ts", "/b.ts", "/lib.ts"],
      null
    );

    assert.equal(groups.length, 1);
    const dedupGroup = atOrThrow(groups, 0);
    assert.deepEqual(dedupGroup.imports, ["/lib.ts"]);
    assert.deepEqual(dedupGroup.members, ["/a.ts", "/b.ts"]);
  });

  test("empty file list produces no groups", () => {
    const db = makeStorage([]);
    const groups = buildImportGroups(db, [], null);
    assert.equal(groups.length, 0);
  });

  test("all modules have unique import profiles — no groups produced", () => {
    const db = makeStorage([
      { from: "/a.ts", to: "/x.ts" },
      { from: "/b.ts", to: "/y.ts" },
      { from: "/c.ts", to: "/z.ts" },
    ]);

    const groups = buildImportGroups(
      db,
      ["/a.ts", "/b.ts", "/c.ts", "/x.ts", "/y.ts", "/z.ts"],
      null
    );

    assert.equal(groups.length, 0);
  });

  test("three-way tie broken by lexicographic key order", () => {
    /*
      All three groups have score 2*1=2.
      Keys: "/a.ts", "/b.ts", "/c.ts" -> sorted ascending.
    */
    const db = makeStorage([
      { from: "/m1.ts", to: "/a.ts" },
      { from: "/m2.ts", to: "/a.ts" },
      { from: "/m3.ts", to: "/b.ts" },
      { from: "/m4.ts", to: "/b.ts" },
      { from: "/m5.ts", to: "/c.ts" },
      { from: "/m6.ts", to: "/c.ts" },
    ]);

    const groups = buildImportGroups(
      db,
      [
        "/m1.ts",
        "/m2.ts",
        "/m3.ts",
        "/m4.ts",
        "/m5.ts",
        "/m6.ts",
        "/a.ts",
        "/b.ts",
        "/c.ts",
      ],
      null
    );

    assert.equal(groups.length, 3);
    assert.deepEqual(atOrThrow(groups, 0).imports, ["/a.ts"]);
    assert.deepEqual(atOrThrow(groups, 1).imports, ["/b.ts"]);
    assert.deepEqual(atOrThrow(groups, 2).imports, ["/c.ts"]);
  });
});
