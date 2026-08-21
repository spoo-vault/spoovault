import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/**/*.test.ts',
      'src/__tests__/VirtualizedDocumentsList.test.tsx',
      'src/__tests__/VirtualizedNftGrid.test.tsx',
    ],
    globals: true,
    pool: 'forks',
    forks: {
      singleFork: true,
    },
    coverage: {
      provider: 'v8',
      include: ['src/services/stellar.service.ts'],
      exclude: ['src/__tests__/**'],
      thresholds: {
        perFile: true,
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 90,
      },
    },
  },
});
