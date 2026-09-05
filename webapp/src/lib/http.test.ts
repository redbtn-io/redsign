import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, firstHeaderValue } from './http.ts';

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

// Proxy chains append to forwarded headers; only the first value is the
// client-facing one. Regression: live signing links were minted as
// "https,http://sign.redbtn.io/sign/..." because X-Forwarded-Proto arrived
// comma-joined through redrouter-proxy -> traefik.

test('firstHeaderValue takes the first of a comma-joined forwarded header', () => {
  assert.equal(firstHeaderValue('https,http'), 'https');
  assert.equal(firstHeaderValue('sign.redbtn.io, 10.100.0.5:3000'), 'sign.redbtn.io');
});

test('firstHeaderValue passes single values through and trims whitespace', () => {
  assert.equal(firstHeaderValue('https'), 'https');
  assert.equal(firstHeaderValue('  sign.redbtn.io '), 'sign.redbtn.io');
});

test('firstHeaderValue returns null for missing or empty headers', () => {
  assert.equal(firstHeaderValue(null), null);
  assert.equal(firstHeaderValue(''), null);
  assert.equal(firstHeaderValue(' , https'), null); // empty first value is no value
});

// --- clientIp (v0.2 audit trail) -----------------------------------------

test('clientIp prefers CF-Connecting-IP over a spoofable forwarded chain', () => {
  // A client can put anything in its own X-Forwarded-For; Cloudflare sets
  // CF-Connecting-IP from the real peer, so it wins.
  const got = clientIp(
    headers({
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '1.2.3.4, 203.0.113.9, 172.16.0.1',
    })
  );
  assert.equal(got.ip, '203.0.113.9');
  assert.equal(got.source, 'cf-connecting-ip');
  assert.match(got.chain ?? '', /cf-connecting-ip=203\.0\.113\.9/);
  assert.match(got.chain ?? '', /x-forwarded-for=1\.2\.3\.4, 203\.0\.113\.9, 172\.16\.0\.1/);
});

test('clientIp falls back to the first forwarded value, then x-real-ip', () => {
  const xff = clientIp(headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }));
  assert.equal(xff.ip, '198.51.100.7');
  assert.equal(xff.source, 'x-forwarded-for');

  const real = clientIp(headers({ 'x-real-ip': '198.51.100.8' }));
  assert.equal(real.ip, '198.51.100.8');
  assert.equal(real.source, 'x-real-ip');
});

test('clientIp records nothing rather than guessing when no header is present', () => {
  assert.deepEqual(clientIp(headers({})), { ip: null, chain: null, source: null });
});

test('clientIp keeps the whole chain, bounded', () => {
  const long = Array.from({ length: 200 }, (_, i) => `10.0.0.${i % 250}`).join(', ');
  const got = clientIp(headers({ 'x-forwarded-for': long }));
  assert.ok((got.chain ?? '').length <= 500);
});
