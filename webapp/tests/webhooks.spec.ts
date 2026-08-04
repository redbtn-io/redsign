import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SignJWT } from 'jose';
import { MongoClient } from 'mongodb';

// Phase 4 webhook dispatch, end to end against a real catcher: an in-test
// HTTP server on 127.0.0.1 (ephemeral port) receives the deliveries — the dev
// server runs on the same host, so no public URL and no AUTH_BYPASS-guarded
// catcher route is needed. Envelopes are sender-created, so deliveries are
// signed with WEBHOOK_FALLBACK_SECRET, which playwright.config.ts pins to a
// known value; every received signature is HMAC-verified in-test.
//
// Envelopes are tagged metadata {e2e:true}; afterAll runs
// scripts/cleanup-e2e-envelopes.mjs, which also purges webhook_deliveries and
// envelope_events for those envelopes.

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'By-Laws.pdf');
const ENV_LOCAL = path.join(process.cwd(), '.env.local');
const HAS_MONGO =
  Boolean(process.env.MONGODB_URI) ||
  (fs.existsSync(ENV_LOCAL) && /^MONGODB_URI=/m.test(fs.readFileSync(ENV_LOCAL, 'utf8')));

// Must match playwright.config.ts webServer.env.WEBHOOK_FALLBACK_SECRET.
const FALLBACK_SECRET = 'redsign-e2e-fallback-secret-0123456789abcdef';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function envLocal(name: string): string | null {
  if (!fs.existsSync(ENV_LOCAL)) return null;
  const m = fs.readFileSync(ENV_LOCAL, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

async function mintSession(): Promise<string | null> {
  const secret = envLocal('JWT_SECRET');
  if (!secret) return null;
  return await new SignJWT({ userId: '6a5a78b83a9346039fb7769f', email: 'agent@redbtn.io', sid: 'e2e' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('6h')
    .sign(new TextEncoder().encode(secret));
}

type Received = { raw: string; sig: string | null; event: string };

function startCatcher(statusCode: () => number): Promise<{
  port: number;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let event = '?';
      try {
        event = JSON.parse(raw).event;
      } catch {
        // keep '?' — the assertion on events will flag it
      }
      received.push({ raw, sig: (req.headers['x-redsign-signature'] as string) ?? null, event });
      res.statusCode = statusCode();
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function verifySig(raw: string, sig: string | null): boolean {
  const expected =
    'sha256=' + crypto.createHmac('sha256', FALLBACK_SECRET).update(raw, 'utf8').digest('hex');
  return sig !== null && sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

test('lifecycle webhooks: sent/viewed/signed/completed delivered with valid HMAC signatures', async ({
  request,
}) => {
  test.skip(!HAS_MONGO, 'MONGODB_URI not configured (CI) — needs a live DB');
  test.setTimeout(120_000);
  const session = await mintSession();
  test.skip(!session, 'JWT_SECRET not configured — cannot authenticate envelope creation');
  const cookie = `red_session=${session}`;

  const catcher = await startCatcher(() => 200);
  try {
    const docName = `Webhook-E2E-${Date.now()}.pdf`;
    const created = await request.post('/api/envelopes', {
      headers: { cookie },
      multipart: {
        document: { name: docName, mimeType: 'application/pdf', buffer: fs.readFileSync(FIXTURE) },
        payload: JSON.stringify({
          signers: [{ name: 'Webhook E2E Signer' }],
          fields: [{ type: 'signature', page: 1, x: 0.1, y: 0.75, w: 0.3, h: 0.06, signerIdx: 0 }],
          metadata: { e2e: true, suite: 'webhooks' },
          webhookUrl: `http://127.0.0.1:${catcher.port}/hook`,
        }),
      },
    });
    expect(created.status()).toBe(201);
    const { envelopeId, signers } = await created.json();
    const token = new URL(signers[0].signingUrl).pathname.split('/').pop()!;

    // --- `sent` fires on creation (immediate fire-and-forget attempt) ---
    await expect.poll(() => catcher.received.map((r) => r.event), { timeout: 15_000 }).toContain('sent');

    // --- first state GET -> `viewed`; a second GET must NOT fire another ---
    expect((await request.get(`/api/sign/${token}`)).status()).toBe(200);
    await expect.poll(() => catcher.received.map((r) => r.event), { timeout: 15_000 }).toContain('viewed');
    expect((await request.get(`/api/sign/${token}`)).status()).toBe(200);

    // --- completing the single signer -> `signed` + `completed` ---
    const done = await request.post(`/api/sign/${token}/complete`, {
      data: { consent: true, values: { '0': PNG_1PX } },
    });
    expect(done.status()).toBe(200);
    expect((await done.json()).completed).toBe(true);
    await expect
      .poll(() => catcher.received.map((r) => r.event), { timeout: 15_000 })
      .toEqual(expect.arrayContaining(['sent', 'viewed', 'signed', 'completed']));

    // --- exactly one `viewed` despite the double GET (viewed-once) ---
    expect(catcher.received.filter((r) => r.event === 'viewed')).toHaveLength(1);

    // --- every delivery carries a VALID X-RedSign-Signature over its raw body ---
    for (const r of catcher.received) {
      expect(verifySig(r.raw, r.sig), `signature must verify for ${r.event}`).toBe(true);
      const body = JSON.parse(r.raw);
      expect(body.envelopeId).toBe(envelopeId);
      expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(body.metadata).toMatchObject({ e2e: true, suite: 'webhooks' });
    }
    const signed = catcher.received.find((r) => r.event === 'signed')!;
    expect(JSON.parse(signed.raw).signerIdx).toBe(0);
    const viewed = catcher.received.find((r) => r.event === 'viewed')!;
    expect(JSON.parse(viewed.raw).signerIdx).toBe(0);
    const sent = catcher.received.find((r) => r.event === 'sent')!;
    expect('signerIdx' in JSON.parse(sent.raw)).toBe(false);

    // --- a tampered body must NOT verify (the test's verifier is honest) ---
    expect(verifySig(sent.raw + 'x', sent.sig)).toBe(false);

    // --- delivery bookkeeping: all rows delivered on the first attempt ---
    const client = new MongoClient(process.env.MONGODB_URI ?? envLocal('MONGODB_URI')!);
    try {
      await client.connect();
      const deliveries = client.db().collection('webhook_deliveries');
      // The catcher's 200 lands before the status write — poll for the
      // bookkeeping to settle rather than racing it.
      await expect
        .poll(async () => await deliveries.countDocuments({ envelopeId, status: 'delivered' }), {
          timeout: 15_000,
        })
        .toBe(4);
      const rows = await deliveries.find({ envelopeId }).toArray();
      expect(rows.length).toBe(4);
      for (const row of rows) {
        expect(row.status).toBe('delivered');
        expect(row.attempts).toBe(1);
        expect(row.deliveredAt).toBeTruthy();
      }
      // envelope_events mirrors the same four lifecycle transitions
      const events = await client.db().collection('envelope_events').find({ envelopeId }).toArray();
      expect(events.map((e) => e.event).sort()).toEqual(['completed', 'sent', 'signed', 'viewed']);
    } finally {
      await client.close();
    }
  } finally {
    await catcher.close();
  }
});

test('failed delivery schedules a retry with 30s backoff (pending, attempts=1)', async ({ request }) => {
  test.skip(!HAS_MONGO, 'MONGODB_URI not configured (CI) — needs a live DB');
  const session = await mintSession();
  test.skip(!session, 'JWT_SECRET not configured — cannot authenticate envelope creation');
  const cookie = `red_session=${session}`;

  const catcher = await startCatcher(() => 500);
  try {
    const created = await request.post('/api/envelopes', {
      headers: { cookie },
      multipart: {
        document: {
          name: `Webhook-Retry-${Date.now()}.pdf`,
          mimeType: 'application/pdf',
          buffer: fs.readFileSync(FIXTURE),
        },
        payload: JSON.stringify({
          signers: [{ name: 'Webhook Retry Signer' }],
          fields: [{ type: 'signature', page: 1, x: 0.1, y: 0.75, w: 0.3, h: 0.06, signerIdx: 0 }],
          metadata: { e2e: true, suite: 'webhooks-retry' },
          webhookUrl: `http://127.0.0.1:${catcher.port}/hook`,
        }),
      },
    });
    expect(created.status()).toBe(201);
    const { envelopeId } = await created.json();

    const client = new MongoClient(process.env.MONGODB_URI ?? envLocal('MONGODB_URI')!);
    try {
      await client.connect();
      const deliveries = client.db().collection('webhook_deliveries');
      await expect
        .poll(async () => (await deliveries.findOne({ envelopeId }))?.attempts ?? 0, {
          timeout: 15_000,
        })
        .toBe(1);
      const row = (await deliveries.findOne({ envelopeId }))!;
      expect(row.status).toBe('pending'); // still retryable, not failed
      expect(row.lastError).toBe('HTTP 500');
      // First retry is scheduled ~30s after the failed attempt.
      const delta = new Date(row.nextAttemptAt).getTime() - new Date(row.updatedAt).getTime();
      expect(delta).toBeGreaterThanOrEqual(29_000);
      expect(delta).toBeLessThanOrEqual(31_000);
    } finally {
      await client.close();
    }
  } finally {
    await catcher.close();
  }
});

test.afterAll(() => {
  if (!HAS_MONGO) return;
  const out = execFileSync(process.execPath, ['scripts/cleanup-e2e-envelopes.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  console.log(out.trim());
});
