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
    // WEBHOOK_FALLBACK_SECRET must match tests/webhooks.spec.ts, which
    // verifies delivered HMAC signatures against the same value. Test-only —
    // prod carries a real secret in the workspace env.
    env: { AUTH_BYPASS: '1', WEBHOOK_FALLBACK_SECRET: 'redsign-e2e-fallback-secret-0123456789abcdef' },
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120000,
  },
  use: {
    baseURL: 'http://localhost:5173',
  },
});
