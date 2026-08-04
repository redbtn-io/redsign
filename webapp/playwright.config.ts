import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Single worker on purpose: compose.spec and signing.spec both create
  // {e2e:true} envelopes in the shared DB and both clean ALL of them up in
  // afterAll — parallel files would let one file's cleanup delete the
  // other's in-flight envelope.
  workers: 1,
  webServer: {
    command: 'npm run dev -- --port 5173',
    env: { AUTH_BYPASS: '1' },
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120000,
  },
  use: {
    baseURL: 'http://localhost:5173',
  },
});
