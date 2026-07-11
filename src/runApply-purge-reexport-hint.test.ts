import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rmSync, promises as fsp } from 'node:fs';
import { assert, test } from 'vitest';
import { runApply } from './runApply';
import { PLAN_VERSION } from './plan';

async function runApplyWithPlan(
  planFileName: string,
  command: string,
): Promise<string> {
  const planFile = join(process.cwd(), planFileName);

  await fsp.writeFile(
    planFile,
    JSON.stringify({
      version: PLAN_VERSION,
      command,
      timestamp: new Date().toISOString(),
      sourceFiles: [],
      targetFiles: [],
      checksums: {},
      changes: [],
    }),
    'utf-8',
  );

  try {
    const output: string[] = [];

    function writer(msg: string): void {
      output.push(msg);
    }

    async function archivePlan(): Promise<string> {
      rmSync(planFile, { force: true });
      return 'archived.json';
    }

    await runApply(planFileName, { writer, archivePlan }, process.cwd());
    return output.join('');
  } finally {
    rmSync(planFile, { force: true });
  }
}

test('runApply suggests propose-purge-reexport after split plans', async () => {
  const outputText = await runApplyWithPlan(
    `test-purge-hint-plan-${randomUUID()}.json`,
    'split',
  );

  assert.ok(
    outputText.includes('propose-purge-reexport'),
    'split plan should suggest propose-purge-reexport',
  );
  assert.ok(
    outputText.includes('unused re-exports'),
    'hint should mention unused re-exports',
  );
});

test('runApply does not suggest propose-purge-reexport for non-split plans', async () => {
  const outputText = await runApplyWithPlan(
    `test-no-purge-hint-plan-${randomUUID()}.json`,
    'mv',
  );

  assert.ok(
    !outputText.includes('propose-purge-reexport'),
    'non-split plan should not suggest propose-purge-reexport',
  );
});
