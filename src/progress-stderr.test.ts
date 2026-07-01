import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjStore } from './objstore';
import { Storage } from './storage';
import { InMemoryFileSystem } from './filesystem';
import { indexImportFromFiles } from './indexing';
import { assert, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('indexImportFromFiles writes progress messages to the writer callback', async () => {
  const progressMessages: string[] = [];

  const testDir = join(__dirname, '.tslor-test-progress-tmp');
  const files = new Map<string, string>([
    [join(testDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} })],
    [join(testDir, 'a.ts'), 'export const a = 1;\n'],
    [join(testDir, 'b.ts'), 'export const b = 2;\n'],
    [join(testDir, 'c.ts'), 'import { a } from "./a";\nexport const c = 3;\n'],
  ]);
  const fileSystem = new InMemoryFileSystem(files);

  const objStore = new ObjStore({ traceId: null });
  const storage = new Storage(objStore, {
    jsonlPath: '/dev/null',
    verbose: true,
    inMemory: true,
  });

  const paths = [
    join(testDir, 'a.ts'),
    join(testDir, 'b.ts'),
    join(testDir, 'c.ts'),
  ];

  await indexImportFromFiles(paths, storage, testDir, true, fileSystem, (msg) =>
    progressMessages.push(msg),
  );

  const progressContent = progressMessages.join('');

  assert.isTrue(
    progressContent.includes('Indexing'),
    'progress writer must contain progress output (Indexing ...)',
  );
});
