import { assert, test, describe } from 'vitest';
import { resolveImportSpec } from './indexing';
import { InMemoryFileSystem } from './filesystem';

describe('resolveImportSpec', () => {
  test('resolves relative imports correctly', async () => {
    // Setup in-memory filesystem
    const fileSystem = new InMemoryFileSystem();
    const repoRoot = '/repo';
    
    // Create directory structure in memory
    fileSystem.setFile('/repo/tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "ESNext"
      }
    }));
    
    fileSystem.setFile('/repo/src/moduleA.ts', 'export const a = 1;');
    fileSystem.setFile('/repo/src/moduleB.ts', 'export const b = 2;');
    fileSystem.setFile('/repo/src/nested/moduleC.ts', 'export const c = 3;');
    
    // Test relative import resolution
    const result = await resolveImportSpec(
      repoRoot,
      '/repo/src/moduleA.ts',
      './moduleB',
      fileSystem
    );
    
    assert.equal(result, '/repo/src/moduleB.ts');
  });

  test('resolves relative imports to parent directory', async () => {
    const fileSystem = new InMemoryFileSystem();
    const repoRoot = '/repo';
    
    fileSystem.setFile('/repo/tsconfig.json', JSON.stringify({
      compilerOptions: {}
    }));
    
    fileSystem.setFile('/repo/src/moduleA.ts', 'export const a = 1;');
    fileSystem.setFile('/repo/src/nested/moduleB.ts', 'export const b = 2;');
    
    // Test that nested module can import from parent directory
    const result = await resolveImportSpec(
      repoRoot,
      '/repo/src/nested/moduleB.ts',
      '../moduleA',
      fileSystem
    );
    
    assert.equal(result, '/repo/src/moduleA.ts');
  });

  test('resolves index.ts in directories', async () => {
    const fileSystem = new InMemoryFileSystem();
    const repoRoot = '/repo';
    
    fileSystem.setFile('/repo/tsconfig.json', JSON.stringify({
      compilerOptions: {}
    }));
    
    fileSystem.setFile('/repo/src/moduleA.ts', 'export const a = 1;');
    fileSystem.setFile('/repo/src/utils/index.ts', 'export const utils = {};');
    
    // Test that importing a directory resolves to index.ts
    const result = await resolveImportSpec(
      repoRoot,
      '/repo/src/moduleA.ts',
      './utils',
      fileSystem
    );
    
    assert.equal(result, '/repo/src/utils/index.ts');
  });

  test('resolves path aliases', async () => {
    const fileSystem = new InMemoryFileSystem();
    const repoRoot = '/repo';
    
    fileSystem.setFile('/repo/tsconfig.json', JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@common/*": ["common/*"]
        }
      }
    }));
    
    fileSystem.setFile('/repo/src/moduleA.ts', 'export const a = 1;');
    fileSystem.setFile('/repo/common/utils.ts', 'export const utils = {};');
    
    // Test path alias resolution
    const result = await resolveImportSpec(
      repoRoot,
      '/repo/src/moduleA.ts',
      '@common/utils',
      fileSystem
    );
    
    assert.equal(result, '/repo/common/utils.ts');
  });

  test('regression: resolves imports when parent directory exists', async () => {
    // This test catches the bug where resolveSourceFile would return null
    // if the parent directory was not a file (i.e., when it was a directory).
    // The bug was: if (!stat.isFile()) return null; 
    // which should have been: if (stat.isFile()) return null;
    
    const fileSystem = new InMemoryFileSystem();
    const repoRoot = '/repo';
    
    fileSystem.setFile('/repo/tsconfig.json', JSON.stringify({
      compilerOptions: {}
    }));
    
    // Create a nested directory structure
    fileSystem.setFile('/repo/src/deeply/nested/moduleA.ts', 'export const a = 1;');
    fileSystem.setFile('/repo/src/deeply/nested/moduleB.ts', 'export const b = 2;');
    
    // This should resolve correctly even though the parent directory exists
    const result = await resolveImportSpec(
      repoRoot,
      '/repo/src/deeply/nested/moduleA.ts',
      './moduleB',
      fileSystem
    );
    
    assert.equal(result, '/repo/src/deeply/nested/moduleB.ts');
  });
});
