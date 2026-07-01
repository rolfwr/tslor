import { assert, describe, test } from 'vitest';
import { isPathWithinDirectory } from './pathUtils';

describe('isPathWithinDirectory', () => {
  test('rejects prefix collision: "/src/other.ts" vs "/src/o"', () => {
    assert.isFalse(isPathWithinDirectory('/src/other.ts', '/src/o'));
  });

  test('matches direct child: "/src/o/file.ts" in "/src/o"', () => {
    assert.isTrue(isPathWithinDirectory('/src/o/file.ts', '/src/o'));
  });

  test('matches exact equality', () => {
    assert.isTrue(isPathWithinDirectory('/src/o', '/src/o'));
  });

  test('rejects prefix collision: "/home/repos/mimir2/foo.ts" vs "/home/repos/mimir"', () => {
    assert.isFalse(
      isPathWithinDirectory('/home/repos/mimir2/foo.ts', '/home/repos/mimir'),
    );
  });

  test('matches nested subdirectory', () => {
    assert.isTrue(
      isPathWithinDirectory(
        '/home/repos/mimir/src/deep/file.ts',
        '/home/repos/mimir',
      ),
    );
  });

  test('rejects backslash in directory path', () => {
    assert.isFalse(isPathWithinDirectory('/src/other.ts', '/src\\'));
  });
});
