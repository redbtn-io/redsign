import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  accessCodeError,
  accessCodeMatches,
  defaultExpiryDays,
  expiresInDaysToDate,
  hashAccessCode,
  hostAllowed,
  isExpired,
  metadataOrgId,
  normalizeAccessCode,
  parseHostAllowlist,
  platformOrgIdError,
  resolveExpiresAt,
  tokenBlock,
  webhookUrlError,
} from './policy.ts';

// --- webhookUrl allowlist -------------------------------------------------

test('parseHostAllowlist falls back to the suite default', () => {
  assert.deepEqual(parseHostAllowlist(undefined), ['.redbtn.io']);
  assert.deepEqual(parseHostAllowlist('  '), ['.redbtn.io']);
  assert.deepEqual(parseHostAllowlist('a.example.com, .b.test'), ['a.example.com', '.b.test']);
});

test('hostAllowed: a leading dot matches the domain and its subdomains', () => {
  assert.equal(hostAllowed('finance.redbtn.io', ['.redbtn.io']), true);
  assert.equal(hostAllowed('redbtn.io', ['.redbtn.io']), true);
  assert.equal(hostAllowed('REDBTN.IO', ['.redbtn.io']), true);
  assert.equal(hostAllowed('evil-redbtn.io', ['.redbtn.io']), false);
  assert.equal(hostAllowed('redbtn.io.attacker.test', ['.redbtn.io']), false);
});

test('hostAllowed: an entry without a dot must match exactly', () => {
  assert.equal(hostAllowed('hooks.example.com', ['hooks.example.com']), true);
  assert.equal(hostAllowed('sub.hooks.example.com', ['hooks.example.com']), false);
});

test('webhookUrlError accepts an https allowlisted host', () => {
  assert.equal(
    webhookUrlError('https://finance.redbtn.io/api/webhooks/redsign', ['.redbtn.io']),
    null
  );
});

test('webhookUrlError refuses http, credentials, IPs and unlisted hosts', () => {
  const allow = ['.redbtn.io'];
  assert.match(webhookUrlError('http://finance.redbtn.io/hook', allow) ?? '', /https/);
  assert.match(
    webhookUrlError('https://user:pw@finance.redbtn.io/hook', allow) ?? '',
    /credentials/
  );
  assert.match(webhookUrlError('https://10.0.0.5/hook', ['10.0.0.5']) ?? '', /IP address/);
  assert.match(webhookUrlError('https://[::1]/hook', allow) ?? '', /IP address/);
  assert.match(webhookUrlError('https://attacker.test/hook', allow) ?? '', /allowlisted/);
  assert.match(webhookUrlError('not-a-url', allow) ?? '', /absolute URL/);
});

// --- expiry ---------------------------------------------------------------

const NOW = new Date('2026-09-05T12:00:00.000Z');

test('defaultExpiryDays clamps nonsense to the default', () => {
  assert.equal(defaultExpiryDays(undefined), DEFAULT_EXPIRY_DAYS);
  assert.equal(defaultExpiryDays('0'), DEFAULT_EXPIRY_DAYS);
  assert.equal(defaultExpiryDays('-3'), DEFAULT_EXPIRY_DAYS);
  assert.equal(defaultExpiryDays(String(MAX_EXPIRY_DAYS + 1)), DEFAULT_EXPIRY_DAYS);
  assert.equal(defaultExpiryDays('30'), 30);
});

test('resolveExpiresAt: omitted means the default window, null means never', () => {
  const d = resolveExpiresAt(undefined, NOW, 90);
  assert.equal(d?.toISOString(), '2026-12-04T12:00:00.000Z');
  assert.equal(resolveExpiresAt(null, NOW), null);
});

test('resolveExpiresAt rejects past dates, junk and dates beyond the cap', () => {
  assert.throws(() => resolveExpiresAt('2020-01-01T00:00:00Z', NOW), /future/);
  assert.throws(() => resolveExpiresAt('nonsense', NOW), /ISO-8601/);
  assert.throws(() => resolveExpiresAt('2099-01-01T00:00:00Z', NOW), /within/);
  assert.throws(() => resolveExpiresAt({}, NOW), /ISO-8601/);
});

test('expiresInDaysToDate: undefined defers, null opts out, a number wins', () => {
  assert.equal(expiresInDaysToDate(undefined, NOW), undefined);
  assert.equal(expiresInDaysToDate(null, NOW), null);
  assert.equal(expiresInDaysToDate(7, NOW)?.toISOString(), '2026-09-12T12:00:00.000Z');
  assert.throws(() => expiresInDaysToDate(0, NOW), /1\.\./);
  assert.throws(() => expiresInDaysToDate(9999, NOW), /1\.\./);
});

test('an envelope with no expiresAt is NEVER expired', () => {
  // Load bearing: envelopes created before v0.2 carry no expiresAt, and the
  // pending W-9 envelope 6a96f5fad8f61708c97e7bc5 is one of them. Defaulting
  // an expiry onto stored envelopes would kill live signing links.
  assert.equal(isExpired({}, NOW), false);
  assert.equal(isExpired({ expiresAt: null }, NOW), false);
  assert.equal(isExpired({ expiresAt: undefined }, NOW), false);
});

test('isExpired honours a set expiry, as Date or ISO string', () => {
  assert.equal(isExpired({ expiresAt: new Date('2026-09-04T00:00:00Z') }, NOW), true);
  assert.equal(isExpired({ expiresAt: '2026-09-04T00:00:00.000Z' }, NOW), true);
  assert.equal(isExpired({ expiresAt: new Date('2026-10-01T00:00:00Z') }, NOW), false);
  assert.equal(isExpired({ expiresAt: NOW }, NOW), true, 'the instant it expires, it is expired');
});

test('tokenBlock: voided wins, then expiry, otherwise the link opens', () => {
  assert.equal(tokenBlock({ status: "sent" }, NOW), null);
  assert.equal(tokenBlock({ status: "voided" }, NOW), 'voided');
  assert.equal(tokenBlock({ status: "sent", expiresAt: '2026-01-01T00:00:00Z' }, NOW), 'expired');
  assert.equal(
    tokenBlock({ status: "voided", expiresAt: '2026-01-01T00:00:00Z' }, NOW),
    'voided',
    'a deliberate cancellation is the more useful thing to tell the signer'
  );
  assert.equal(tokenBlock({ status: "completed" }, NOW), null, 'completed is handled by the page, not blocked');
});

// --- access codes ---------------------------------------------------------

const TOKEN = 'a'.repeat(48);

test('normalizeAccessCode strips spacing and case', () => {
  assert.equal(normalizeAccessCode(' ab-12 cd '), 'AB12CD');
  assert.equal(normalizeAccessCode(null), '');
});

test('accessCodeError enforces the length bounds after normalisation', () => {
  assert.equal(accessCodeError('4821'), null);
  assert.match(accessCodeError('12') ?? '', /at least/);
  assert.match(accessCodeError('x'.repeat(33)) ?? '', /at most/);
  assert.equal(accessCodeError('12-34'), null, 'a dash does not count toward the length');
});

test('the stored digest is keyed by the signer token, so it is useless alone', () => {
  const a = hashAccessCode(TOKEN, '4821');
  const b = hashAccessCode('b'.repeat(48), '4821');
  assert.notEqual(a, b);
  assert.equal(a, hashAccessCode(TOKEN, ' 48-21 '), 'normalised before hashing');
});

test('accessCodeMatches: no code configured means open', () => {
  assert.equal(accessCodeMatches({ token: TOKEN }, null), true);
  assert.equal(accessCodeMatches({ token: TOKEN, accessCodeHash: null }, null), true);
});

test('accessCodeMatches: a configured code must be presented and correct', () => {
  const signer = { token: TOKEN, accessCodeHash: hashAccessCode(TOKEN, '4821') };
  assert.equal(accessCodeMatches(signer, '4821'), true);
  assert.equal(accessCodeMatches(signer, '48 21'), true);
  assert.equal(accessCodeMatches(signer, '9999'), false);
  assert.equal(accessCodeMatches(signer, null), false);
  assert.equal(accessCodeMatches(signer, ''), false);
});

// --- platform consumers ---------------------------------------------------

test('metadataOrgId reads only a non-empty string', () => {
  assert.equal(metadataOrgId({ orgId: 'org_123' }), 'org_123');
  assert.equal(metadataOrgId({ orgId: '  ' }), null);
  assert.equal(metadataOrgId({ orgId: 7 }), null);
  assert.equal(metadataOrgId(null), null);
});

test('platformOrgIdError only bites platform consumers', () => {
  assert.equal(platformOrgIdError({ platform: false }, {}), null);
  assert.equal(platformOrgIdError(null, {}), null);
  assert.match(platformOrgIdError({ platform: true }, {}) ?? '', /metadata\.orgId is required/);
  assert.equal(platformOrgIdError({ platform: true }, { orgId: 'org_123' }), null);
  assert.match(
    platformOrgIdError({ platform: true }, { orgId: 'not a valid id!' }) ?? '',
    /not a valid org id/
  );
});
