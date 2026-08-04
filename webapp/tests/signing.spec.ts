import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SignJWT } from 'jose';
import { PDFDocument } from 'pdf-lib';

// Phase 3 public signing flow, end to end: compose a 2-signer envelope via
// the API, verify sequential ordering (signer 2 waits, out-of-turn completes
// 409), sign as both signers through the real /sign/[token] UI (drawn
// signatures on the canvas), and assert the envelope completes with an
// executed PDF whose page count is original + 1 (the certificate page).
//
// Requires Mongo (dev server reads MONGODB_URI from .env.local); the
// tokens-only 404 test runs everywhere. Envelopes are tagged metadata
// {e2e:true} and cleaned up via scripts/cleanup-e2e-envelopes.mjs.

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'By-Laws.pdf');
const ENV_LOCAL = path.join(process.cwd(), '.env.local');
const HAS_MONGO =
  Boolean(process.env.MONGODB_URI) ||
  (fs.existsSync(ENV_LOCAL) && /^MONGODB_URI=/m.test(fs.readFileSync(ENV_LOCAL, 'utf8')));

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

// Draw a squiggle on the signature canvas and save it.
async function drawSignature(page: Page) {
  const canvas = page.getByTestId('signature-canvas');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y - 20, { steps: 6 });
  await page.mouse.move(box.x + box.width - 20, y + 15, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save' }).click();
}

test('signing page: malformed token shows the friendly 404', async ({ page }) => {
  await page.goto('/sign/not-a-real-token', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-notfound')).toBeVisible();
  await expect(page.getByTestId('sign-notfound')).toContainText("isn't valid");
});

test('full 2-signer signing flow: waiting, ordering, drawn signatures, executed PDF', async ({
  page,
  request,
}) => {
  test.skip(!HAS_MONGO, 'MONGODB_URI not configured (CI) — needs a live DB');
  test.setTimeout(180_000);
  const session = await mintSession();
  test.skip(!session, 'JWT_SECRET not configured — cannot authenticate envelope creation');
  const cookie = `red_session=${session}`;

  // --- compose a 2-signer envelope via the API ---
  const original = fs.readFileSync(FIXTURE);
  const created = await request.post('/api/envelopes', {
    headers: { cookie },
    multipart: {
      document: { name: 'By-Laws.pdf', mimeType: 'application/pdf', buffer: original },
      payload: JSON.stringify({
        signers: [{ name: 'E2E Signer One' }, { name: 'E2E Signer Two' }],
        fields: [
          { type: 'signature', page: 1, x: 0.1, y: 0.75, w: 0.3, h: 0.06, signerIdx: 0 },
          { type: 'date', page: 1, x: 0.55, y: 0.75, w: 0.2, h: 0.045, signerIdx: 0 },
          { type: 'signature', page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.06, signerIdx: 1 },
        ],
        metadata: { e2e: true, suite: 'signing' },
      }),
    },
  });
  expect(created.status()).toBe(201);
  const { envelopeId, signers } = await created.json();
  expect(envelopeId).toBeTruthy();
  const path1 = new URL(signers[0].signingUrl).pathname;
  const path2 = new URL(signers[1].signingUrl).pathname;
  const token2 = path2.split('/').pop()!;

  // --- unknown-but-well-formed token 404s at the API ---
  const unknown = await request.get(`/api/sign/${'f'.repeat(48)}`);
  expect(unknown.status()).toBe(404);

  // --- signer 2 is blocked: page explains whose turn it is ---
  await page.goto(path2, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('waiting-on')).toBeVisible();
  await expect(page.getByTestId('waiting-on')).toContainText('E2E Signer One');

  // --- completing out of turn is blocked server-side with 409 ---
  const outOfTurn = await request.post(`/api/sign/${token2}/complete`, {
    data: { consent: true, values: { '2': PNG_1PX } },
  });
  expect(outOfTurn.status()).toBe(409);

  // --- signer 1 signs on a phone-sized viewport (primary target) ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path1, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-signer-name')).toContainText('E2E Signer One');

  // Date field prefilled with today, still editable.
  await expect(page.getByTestId('sign-field-1')).toHaveValue(/\w+ \d{1,2}, \d{4}/);

  // Draw the signature via the reused SignatureCanvas dialog.
  await page.getByTestId('sign-field-0').click();
  await drawSignature(page);

  // Consent gates the button; completing flips to the success screen.
  const finish = page.getByTestId('sign-finish');
  await expect(finish).toBeDisabled();
  await page.getByTestId('sign-consent').check();
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(page.getByTestId('sign-success')).toBeVisible();
  await expect(page.getByTestId('sign-success')).toContainText(
    "You're done — E2E Signer One signed By-Laws.pdf"
  );

  // Revisiting after signing shows the already-signed notice.
  await page.goto(path1, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-already')).toBeVisible();

  // --- signer 2 signs (desktop viewport), envelope completes ---
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(path2, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-signer-name')).toContainText('E2E Signer Two');
  // Their field lives on page 2.
  await page.getByTestId('sign-next-page').click();
  await page.getByTestId('sign-field-2').click();
  await drawSignature(page);
  await page.getByTestId('sign-consent').check();
  await page.getByTestId('sign-finish').click();
  await expect(page.getByTestId('sign-success')).toBeVisible();

  // --- envelope is completed with an executed file ---
  const envRes = await request.get(`/api/envelopes/${envelopeId}`, { headers: { cookie } });
  expect(envRes.status()).toBe(200);
  const { envelope } = await envRes.json();
  expect(envelope.status).toBe('completed');
  expect(envelope.completedAt).toBeTruthy();
  expect(envelope.executedFileId).toBeTruthy();
  expect(envelope.signers.every((s: { status: string }) => s.status === 'signed')).toBe(true);
  expect(envelope.signers[0].consentAt).toBeTruthy();
  expect(envelope.signers[0].ip !== undefined).toBe(true);

  // Signer links now show the completed notice, not the document.
  await page.goto(path2, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sign-completed')).toBeVisible();

  // --- executed PDF: served executed-first, page count = original + 1 ---
  const docRes = await request.get(`/api/envelopes/${envelopeId}/document`, {
    headers: { cookie },
  });
  expect(docRes.status()).toBe(200);
  expect(docRes.headers()['content-disposition'] ?? '').toContain('-executed');
  const executedBytes = await docRes.body();
  const executedDoc = await PDFDocument.load(new Uint8Array(executedBytes));
  const originalDoc = await PDFDocument.load(new Uint8Array(original));
  expect(executedDoc.getPageCount()).toBe(originalDoc.getPageCount() + 1);
});

test.afterAll(() => {
  if (!HAS_MONGO) return;
  const out = execFileSync(process.execPath, ['scripts/cleanup-e2e-envelopes.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  console.log(out.trim());
});
