import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstHeaderValue } from './http.ts';

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
