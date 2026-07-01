import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assert, test } from 'vitest';
import { runApply } from './runApply';

test('runApply catches archivePlan failure and preserves original plan file', async () => {
  const planFileName = `test-archive-error-plan-${randomUUID()}.json`;
  const planFile = join(process.cwd(), planFileName);

  const planContent = JSON.stringify({
    version: '1.0.0',
    command: 'split',
    timestamp: new Date().toISOString(),
    sourceFiles: [],
    targetFiles: [],
    checksums: {},
    changes: [],
  });

  await fsp.writeFile(planFile, planContent, 'utf-8');

  try {
    const warnLogs: string[] = [];
    const warn = (message: string) => warnLogs.push(message);

    await runApply(
      planFile,
      {
        warn,
        archivePlan: () => {
          throw new Error('read-only filesystem error');
        },
      },
      process.cwd(),
    );

    assert.ok(
      existsSync(planFile),
      'original plan file must be preserved when archive fails',
    );

    const warnText = warnLogs.join('\n');
    assert.ok(
      warnText.includes('Could not archive plan file'),
      'warning must mention archive failure',
    );
    assert.ok(
      warnText.includes('preserved'),
      'warning must mention plan file is preserved',
    );
  } finally {
    rmSync(planFile, { force: true });
  }
});
