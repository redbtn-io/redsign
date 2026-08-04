import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SignJWT } from 'jose';

// Phase 4 sender dashboard (/envelopes): list with status + signer progress,
// expandable detail (per-signer state, copy signing link, events timeline),
// void with confirm dialog. 390x844 is the primary viewport (mobile-first);
// a desktop pass sanity-checks the wide layout.

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'By-Laws.pdf');
const ENV_LOCAL = path.join(process.cwd(), '.env.local');
const HAS_MONGO =
  Boolean(process.env.MONGODB_URI) ||
  (fs.existsSync(ENV_LOCAL) && /^MONGODB_URI=/m.test(fs.readFileSync(ENV_LOCAL, 'utf8')));

async function mintSession(): Promise<string | null> {
  if (!fs.existsSync(ENV_LOCAL)) return null;
  const m = fs.readFileSync(ENV_LOCAL, 'utf8').match(/^JWT_SECRET=(.*)$/m);
  if (!m) return null;
  const secret = m[1].trim().replace(/^"|"$/g, '');
  return await new SignJWT({ userId: '6a5a78b83a9346039fb7769f', email: 'agent@redbtn.io', sid: 'e2e' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('6h')
    .sign(new TextEncoder().encode(secret));
}

test('dashboard: progress, expandable detail, copy link, events, void with confirm', async ({
  page,
  request,
}) => {
  test.skip(!HAS_MONGO, 'MONGODB_URI not configured (CI) — needs a live DB');
  test.setTimeout(120_000);
  const session = await mintSession();
  test.skip(!session, 'JWT_SECRET not configured — cannot authenticate');
  const cookie = `red_session=${session}`;
  await page.context().addCookies([{ name: 'red_session', value: session!, url: 'http://localhost:5173' }]);

  // A pending 2-signer envelope with a unique name to find its row by.
  const docName = `Dashboard-E2E-${Date.now()}.pdf`;
  const created = await request.post('/api/envelopes', {
    headers: { cookie },
    multipart: {
      document: { name: docName, mimeType: 'application/pdf', buffer: fs.readFileSync(FIXTURE) },
      payload: JSON.stringify({
        signers: [{ name: 'Dash Signer One' }, { name: 'Dash Signer Two' }],
        fields: [
          { type: 'signature', page: 1, x: 0.1, y: 0.75, w: 0.3, h: 0.06, signerIdx: 0 },
          { type: 'signature', page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.06, signerIdx: 1 },
        ],
        metadata: { e2e: true, suite: 'dashboard' },
      }),
    },
  });
  expect(created.status()).toBe(201);
  const { envelopeId } = await created.json();

  // --- 390x844: primary viewport ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/envelopes', { waitUntil: 'domcontentloaded' });

  const row = page.getByTestId('envelope-row').filter({ hasText: docName });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('envelope-status')).toHaveText('sent');
  await expect(row.getByTestId('envelope-progress')).toHaveText('0/2 signed');

  // Nothing may overflow the phone viewport horizontally.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // --- expand: signers, copy link, events timeline ---
  await row.getByTestId('envelope-toggle').click();
  await expect(row.getByTestId('envelope-detail')).toBeVisible();
  await expect(row.getByTestId('signer-row')).toHaveCount(2);
  await expect(row.getByTestId('signer-row').first()).toContainText('Dash Signer One');
  await expect(row.getByTestId('signer-row').first()).toContainText('not viewed yet');

  // Copy signing link (pending signers only — both here).
  await expect(row.getByTestId('copy-signing-link')).toHaveCount(2);
  await row.getByTestId('copy-signing-link').first().click();
  await expect(row.getByTestId('copy-signing-link').first()).toHaveText('Copied');

  // The links endpoint the button reads from serves full signing URLs.
  const links = await request.get(`/api/envelopes/${envelopeId}/links`, { headers: { cookie } });
  expect(links.status()).toBe(200);
  const { signers: linkRows } = await links.json();
  expect(linkRows).toHaveLength(2);
  for (const l of linkRows) expect(l.signingUrl).toMatch(/^https?:\/\/[^,\s]+\/sign\/[a-f0-9]{48}$/);

  // Events timeline shows the `sent` transition.
  await expect(row.getByTestId('events-timeline')).toBeVisible();
  await expect(row.getByTestId('event-item')).toContainText(['sent']);

  // --- void: confirm dialog, then the row flips to voided ---
  await row.getByTestId('void-button').click();
  await expect(page.getByTestId('void-confirm')).toBeVisible();
  await page.getByTestId('void-confirm').click();
  await expect(row.getByTestId('envelope-status')).toHaveText('voided', { timeout: 15_000 });

  const after = await request.get(`/api/envelopes/${envelopeId}`, { headers: { cookie } });
  expect((await after.json()).envelope.status).toBe('voided');
  const events = await request.get(`/api/envelopes/${envelopeId}/events`, { headers: { cookie } });
  const names = ((await events.json()).events as Array<{ event: string }>).map((e) => e.event);
  expect(names).toContain('voided');
  expect(names).toContain('sent');

  // --- desktop pass: same row renders at 1440x900 ---
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/envelopes', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('envelope-row').filter({ hasText: docName })).toHaveCount(1);
});

test('nav: shell header links between compose and envelopes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('nav-envelopes')).toBeVisible();
  await page.getByTestId('nav-envelopes').click();
  await expect(page).toHaveURL(/\/envelopes$/);
  await page.getByTestId('nav-compose').click();
  await expect(page).toHaveURL(/\/$/);
});

test.afterAll(() => {
  if (!HAS_MONGO) return;
  const out = execFileSync(process.execPath, ['scripts/cleanup-e2e-envelopes.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  console.log(out.trim());
});
