import { defineConfig } from 'vitest/config';

const processTests = [
  'tests/cli/configSecretLeak.test.ts',
  'tests/gitleaksIfPresent.test.ts',
  'tests/sources/readSource.test.ts',
  'tests/sources/repoRead.gitfail.test.ts',
  'tests/sources/repoRead.test.ts',
  'tests/tempCleanup.test.ts'
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [...processTests, '**/node_modules/**', '**/.git/**'],
          environment: 'node',
          setupFiles: ['./tests/setup.ts']
        }
      },
      {
        test: {
          name: 'process',
          include: processTests,
          fileParallelism: false,
          environment: 'node',
          setupFiles: ['./tests/setup.ts']
        }
      }
    ]
  }
});
