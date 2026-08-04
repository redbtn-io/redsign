import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  buildWebhookBody,
  deliveryTransition,
  retryDelayMs,
  shouldMarkViewed,
  signBody,
  verifySignature,
} from './webhooksig.ts';

// --- HMAC signature ---

test('signBody produces sha256=<hmac-hex of the raw body>', () => {
  const secret = 'test-webhook-secret-0123456789abcdef';
  const body = '{"event":"sent","envelopeId":"abc123","at":"2026-08-04T00:00:00.000Z","metadata":{}}';
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(signBody(secret, body), expected);
  // hex is 64 chars for sha256
  assert.match(signBody(secret, body), /^sha256=[a-f0-9]{64}$/);
});

test('signBody differs across secrets and across bodies', () => {
  const body = '{"event":"sent"}';
  assert.notEqual(signBody('secret-a-0123456789', body), signBody('secret-b-0123456789', body));
  assert.notEqual(signBody('secret-a-0123456789', body), signBody('secret-a-0123456789', body + ' '));
});

test('verifySignature accepts the matching header and rejects everything else', () => {
  const secret = 'test-webhook-secret-0123456789abcdef';
  const body = '{"event":"completed","envelopeId":"e1","at":"2026-08-04T01:02:03.000Z","metadata":{"k":1}}';
  const header = signBody(secret, body);
  assert.equal(verifySignature(secret, body, header), true);
  assert.equal(verifySignature(secret, body + 'x', header), false); // tampered body
  assert.equal(verifySignature('wrong-secret-0123456789', body, header), false); // wrong secret
  assert.equal(verifySignature(secret, body, header.slice(0, -1)), false); // truncated (length mismatch)
  assert.equal(verifySignature(secret, body, null), false);
  assert.equal(verifySignature(secret, body, ''), false);
});

// --- payload shape ---

test('buildWebhookBody matches the contract payload', () => {
  const at = new Date('2026-08-04T12:00:00.000Z');
  const withSigner = JSON.parse(
    buildWebhookBody({ event: 'signed', envelopeId: 'env1', signerIdx: 2, at, metadata: { contractorId: 'c1' } })
  );
  assert.deepEqual(withSigner, {
    event: 'signed',
    envelopeId: 'env1',
    signerIdx: 2,
    at: '2026-08-04T12:00:00.000Z',
    metadata: { contractorId: 'c1' },
  });

  // signerIdx omitted (not null) for envelope-level events; metadata coerced to {}.
  const noSigner = JSON.parse(buildWebhookBody({ event: 'sent', envelopeId: 'env1', at, metadata: null }));
  assert.equal('signerIdx' in noSigner, false);
  assert.deepEqual(noSigner.metadata, {});

  // signerIdx 0 is a real signer, not falsy-omitted.
  const idx0 = JSON.parse(buildWebhookBody({ event: 'viewed', envelopeId: 'env1', signerIdx: 0, at, metadata: {} }));
  assert.equal(idx0.signerIdx, 0);
});

// --- retry backoff scheduling ---

test('retryDelayMs walks 30s -> 2m -> 10m and stays at 10m', () => {
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(retryDelayMs(3), 600_000);
  assert.equal(retryDelayMs(4), 600_000);
});

test('deliveryTransition schedules retries with backoff and caps at 5 attempts', () => {
  const now = new Date('2026-08-04T12:00:00.000Z');

  // success on any attempt → delivered, no retry
  assert.deepEqual(deliveryTransition(0, true, now), { status: 'delivered', attempts: 1, nextAttemptAt: null });
  assert.deepEqual(deliveryTransition(3, true, now), { status: 'delivered', attempts: 4, nextAttemptAt: null });

  // failure ladder: +30s, +2m, +10m, +10m, then failed
  const f1 = deliveryTransition(0, false, now);
  assert.equal(f1.status, 'pending');
  assert.equal(f1.attempts, 1);
  assert.equal(f1.nextAttemptAt!.getTime(), now.getTime() + 30_000);

  const f2 = deliveryTransition(f1.attempts, false, now);
  assert.equal(f2.nextAttemptAt!.getTime(), now.getTime() + 120_000);

  const f3 = deliveryTransition(f2.attempts, false, now);
  assert.equal(f3.nextAttemptAt!.getTime(), now.getTime() + 600_000);

  const f4 = deliveryTransition(f3.attempts, false, now);
  assert.equal(f4.status, 'pending');
  assert.equal(f4.nextAttemptAt!.getTime(), now.getTime() + 600_000);

  const f5 = deliveryTransition(f4.attempts, false, now);
  assert.deepEqual(f5, { status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS, nextAttemptAt: null });
});

test('backoff table is the documented 30s / 2m / 10m', () => {
  assert.deepEqual([...RETRY_BACKOFF_MS], [30_000, 120_000, 600_000]);
});

// --- viewed-once semantics ---

test('shouldMarkViewed: only when nothing recorded yet (missing or null)', () => {
  assert.equal(shouldMarkViewed({}), true);
  assert.equal(shouldMarkViewed({ viewedAt: null }), true);
  assert.equal(shouldMarkViewed({ viewedAt: undefined }), true);
  assert.equal(shouldMarkViewed({ viewedAt: new Date() }), false);
  assert.equal(shouldMarkViewed({ viewedAt: '2026-08-04T00:00:00.000Z' }), false);
});
