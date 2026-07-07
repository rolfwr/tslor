import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    silent: true,
    reporters: ['dot'],
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 8,
        minThreads: 2,
      },
    },
    sequence: {
      concurrent: true,
    },
  },
});
