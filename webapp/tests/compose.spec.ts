import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SignJWT } from 'jose';

// Phase 2b sender compose flow. The mocked-API test always runs (CI has no
// Mongo — .env.local is gitignored); the real-POST test runs wherever
// MONGODB_URI is configured and cleans up after itself via
// scripts/cleanup-e2e-envelopes.mjs (envelopes are marked metadata {e2e:true}
// through the composer's ?e2e=1 hook).

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'By-Laws.pdf');
const ENV_LOCAL = path.join(process.cwd(), '.env.local');
const HAS_MONGO =
  Boolean(process.env.MONGODB_URI) ||
  (fs.existsSync(ENV_LOCAL) && /^MONGODB_URI=/m.test(fs.readFileSync(ENV_LOCAL, 'utf8')));

// AUTH_BYPASS=1 only disarms the middleware; the envelope route's own
// authenticate() still wants a red_session cookie, so the real-POST test
// mints one with the same JWT_SECRET the dev server loads from .env.local.
async function mintSession(): Promise<string | null> {
  if (!fs.existsSync(ENV_LOCAL)) return null;
  const m = fs.readFileSync(ENV_LOCAL, 'utf8').match(/^JWT_SECRET=(.*)$/m);
  if (!m) return null;
  const secret = m[1].trim().replace(/^"|"$/g, '');
  return await new SignJWT({ userId: 'e2e', email: 'agent@redbtn.io', sid: 'e2e' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}

async function loadPdfAndEnterCompose(page: Page, url = '/') {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file-upload', FIXTURE);
  // Default mode is the untouched self-sign preview...
  await expect(page.getByText('PDF Preview:')).toBeVisible();
  // ...then switch into the sender flow.
  await page.getByTestId('mode-compose').click();
  await expect(page.getByTestId('composer-send')).toBeVisible();
}

test('compose: add signers, place + remove fields, send (mocked API)', async ({ page }) => {
  await page.route('**/api/envelopes', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        envelopeId: 'mock-envelope-1',
        signers: [
          { idx: 0, signingUrl: 'http://localhost:5173/sign/' + 'a'.repeat(48) },
          { idx: 1, signingUrl: 'http://localhost:5173/sign/' + 'b'.repeat(48) },
        ],
      }),
    }),
  );

  await loadPdfAndEnterCompose(page);

  // Send is gated until signers have names and a field is placed.
  await expect(page.getByTestId('composer-send')).toBeDisabled();

  await page.getByTestId('signer-name').first().fill('Ada Lovelace');
  await page.getByTestId('composer-add-signer').click();
  await expect(page.getByTestId('composer-signer')).toHaveCount(2);
  await page.getByTestId('signer-name').nth(1).fill('Grace Hopper');
  await page.getByTestId('signer-email').nth(1).fill('grace@example.com');

  // Second signer became the active one — their field goes down first.
  await page.getByTestId('composer-add-field').click();
  await expect(page.getByTestId('compose-field')).toHaveCount(1);
  await expect(page.getByTestId('compose-field')).toContainText('Grace');

  // Fields can be removed again.
  await page.getByTestId('compose-field-remove').click();
  await expect(page.getByTestId('compose-field')).toHaveCount(0);

  // Place one for signer 1 (select first, then drop).
  await page.getByTestId('composer-signer').first().click();
  await page.getByTestId('composer-add-field').click();
  await expect(page.getByTestId('compose-field')).toHaveCount(1);
  await expect(page.getByTestId('compose-field')).toContainText('Ada');

  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('composer-result')).toBeVisible();
  await expect(page.getByTestId('signing-link')).toHaveCount(2);
  await expect(page.getByTestId('signing-link').first()).toContainText('/sign/');
  await expect(page.getByTestId('signing-link-row').first()).toContainText('Ada Lovelace');
});

test('compose: real POST creates a live envelope and returns signing links', async ({ page }) => {
  test.skip(!HAS_MONGO, 'MONGODB_URI not configured (CI) — mocked test covers the UI flow');
  const session = await mintSession();
  test.skip(!session, 'JWT_SECRET not configured — cannot authenticate the POST');
  await page.context().addCookies([
    { name: 'red_session', value: session!, url: 'http://localhost:5173' },
  ]);

  // ?e2e=1 makes the composer tag the envelope metadata {e2e:true} so the
  // cleanup script can find and delete it (plus its GridFS chunks).
  await loadPdfAndEnterCompose(page, '/?e2e=1');
  await page.getByTestId('signer-name').first().fill('E2E Compose Bot');
  await page.getByTestId('composer-add-field').click();
  await expect(page.getByTestId('compose-field')).toHaveCount(1);

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/envelopes') && r.request().method() === 'POST'),
    page.getByTestId('composer-send').click(),
  ]);
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  expect(body.envelopeId).toBeTruthy();

  await expect(page.getByTestId('composer-result')).toBeVisible();
  await expect(page.getByTestId('signing-link')).toHaveText(/\/sign\/[0-9a-f]{48}$/);

  // Tap-to-copy feedback.
  await page.getByTestId('copy-link').first().click();
  await expect(page.getByTestId('copy-link').first()).toHaveText('Copied');
});

test.afterAll(() => {
  if (!HAS_MONGO) return;
  const out = execFileSync(process.execPath, ['scripts/cleanup-e2e-envelopes.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  console.log(out.trim());
});
