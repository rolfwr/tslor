import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, rmSync, promises as fsp } from 'node:fs';
import { archivePlan } from './plan';
import { assert, test } from 'vitest';

test('archivePlan archives plan file and removes original', async () => {
  const planFileName = `test-plan-${randomUUID()}.json`;
  const planFile = join(process.cwd(), planFileName);
  const planContent = JSON.stringify({ hello: 'world' });

  await fsp.writeFile(planFile, planContent, 'utf-8');

  let archivedFile: string | undefined;

  try {
    archivedFile = await archivePlan(planFile);

    assert.ok(
      archivedFile.includes('.applied-') && archivedFile.endsWith('.json'),
      'archivePlan returns a valid archived file path',
    );

    assert.ok(!existsSync(planFile), 'original plan file should be removed');

    const archivedContent = await fsp.readFile(archivedFile, 'utf-8');
    assert.strictEqual(
      archivedContent,
      planContent,
      'archived file preserves original content',
    );
  } finally {
    if (archivedFile) {
      rmSync(archivedFile, { force: true });
    }
    rmSync(planFile, { force: true });
  }
});
