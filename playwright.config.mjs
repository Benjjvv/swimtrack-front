import { defineConfig, devices } from '@playwright/test';

const configuredBaseUrl = process.env.SWIMTRACK_E2E_BASE_URL;
const baseURL = configuredBaseUrl || 'http://127.0.0.1:7102/';

export default defineConfig({
  testDir: './tests/e2e/specs',
  outputDir: 'test-results/playwright',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['dot'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    viewport: { width: 480, height: 760 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: configuredBaseUrl ? undefined : {
    command: 'uv run --with-requirements requirements.txt flask --app app run --host 127.0.0.1 --port 7102',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 30_000,
  },
});
