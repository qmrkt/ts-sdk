import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      'node_modules/**',
      'dist/**',
      'src/clients/__tests__/frontend-drift.test.ts',
      'src/clients/__tests__/e2e-localnet.test.ts',
      'src/clients/__tests__/atomicity-localnet.test.ts',
      'src/clients/__tests__/stress-test.test.ts',
      'src/clients/__tests__/avm-budget-benchmark.test.ts',
      'src/clients/__tests__/resolution-engine-smoke.test.ts',
    ],
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
})
