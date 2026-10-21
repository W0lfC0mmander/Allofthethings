// Serves the app folder as-is (no build step) and opens it in a phone-sized Chromium.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Pixel 7'],
    baseURL: 'http://127.0.0.1:8123/',
    serviceWorkers: 'block', // test the files as they are, not a cached copy
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 8123 --bind 127.0.0.1 --directory ..',
    url: 'http://127.0.0.1:8123/index.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
