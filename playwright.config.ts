import { defineConfig } from '@playwright/test'
const visible = process.env.ZHUMO_E2E_VISIBLE === '1'
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: `work/e2e-${visible ? 'visible' : 'background'}-results.json` }]
  ],
  metadata: {
    executionMode: visible ? 'visible-desktop' : 'background-renderer',
    clipboard: visible ? 'native-system' : 'isolated-test-double'
  },
  outputDir: `./work/e2e-${visible ? 'visible' : 'background'}-results`,
  use: { trace: 'retain-on-failure' }
})
