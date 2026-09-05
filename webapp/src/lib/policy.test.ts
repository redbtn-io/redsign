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
  envelopeAccessDenial,
  orgIdError,
  orgScopeFilter,
  ownsEnvelopeFor,
  platformOrgIdError,
  resolveEnvelopeOrgId,
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

// --- tenant attribution and tenant scope ----------------------------------

const PLATFORM = { kind: 'consumer', name: 'redoffice', platform: true, orgId: null } as const;
const PINNED = { kind: 'consumer', name: 'acme', platform: false, orgId: 'org_abc' } as const;
const PLAIN = { kind: 'consumer', name: 'redfinance', platform: false, orgId: null } as const;
const SENDER = { kind: 'sender', email: 'george@redbtn.io' } as const;

test('orgIdError accepts null and rejects a malformed id', () => {
  assert.equal(orgIdError(null), null);
  assert.equal(orgIdError('org_abc-1.2:3'), null);
  assert.match(orgIdError('not a valid id!') ?? '', /not a valid org id/);
  assert.match(orgIdError('x'.repeat(65)) ?? '', /not a valid org id/);
});

test('a pinned consumer cannot attribute an envelope to another org', () => {
  // The consumer row wins over the request body, and a disagreeing assertion
  // is refused rather than ignored: a wrong tenant on an audit record is worse
  // than a rejected send.
  assert.deepEqual(resolveEnvelopeOrgId(PINNED, {}), { orgId: 'org_abc', error: null });
  assert.deepEqual(resolveEnvelopeOrgId(PINNED, { orgId: 'org_abc' }), {
    orgId: 'org_abc',
    error: null,
  });
  const bad = resolveEnvelopeOrgId(PINNED, { orgId: 'org_victim' });
  assert.equal(bad.orgId, null);
  assert.match(bad.error ?? '', /does not match this consumer's org \(org_abc\)/);
});

test('a platform consumer must assert a well formed org, and it is stored', () => {
  assert.match(resolveEnvelopeOrgId(PLATFORM, {}).error ?? '', /metadata\.orgId is required/);
  assert.match(
    resolveEnvelopeOrgId(PLATFORM, { orgId: 'not valid!' }).error ?? '',
    /not a valid org id/
  );
  assert.deepEqual(resolveEnvelopeOrgId(PLATFORM, { orgId: 'org_t1' }), {
    orgId: 'org_t1',
    error: null,
  });
});

test('an unpinned caller may attribute freely, but only a valid org id is stored', () => {
  assert.deepEqual(resolveEnvelopeOrgId(PLAIN, {}), { orgId: null, error: null });
  assert.deepEqual(resolveEnvelopeOrgId(PLAIN, { orgId: 'org_x' }), { orgId: 'org_x', error: null });
  assert.deepEqual(resolveEnvelopeOrgId(SENDER, { orgId: 'org_x' }), {
    orgId: 'org_x',
    error: null,
  });
  // An arbitrary string of any length must not land in envelope.orgId.
  assert.match(resolveEnvelopeOrgId(SENDER, { orgId: 'x'.repeat(65) }).error ?? '', /not a valid/);
});

test('ownership is checked before tenancy, and answers 404', () => {
  const theirs = { createdBy: 'consumer:someone-else', orgId: 'org_t1' };
  assert.equal(ownsEnvelopeFor(PLATFORM, theirs), false);
  assert.deepEqual(envelopeAccessDenial(PLATFORM, theirs, 'org_t1'), {
    status: 404,
    error: 'not found',
  });
  assert.equal(ownsEnvelopeFor(SENDER, theirs), true);
});

test('a platform consumer must name its tenant and cannot read another one', () => {
  const t1 = { createdBy: 'consumer:redoffice', orgId: 'org_t1' };
  const t2 = { createdBy: 'consumer:redoffice', orgId: 'org_t2' };
  // One credential, many tenants: createdBy alone lets it read everything.
  assert.equal(ownsEnvelopeFor(PLATFORM, t2), true);
  assert.deepEqual(envelopeAccessDenial(PLATFORM, t1, null), {
    status: 400,
    error: 'orgId query parameter is required for platform consumers',
  });
  assert.equal(envelopeAccessDenial(PLATFORM, t1, 'org_t1'), null);
  assert.deepEqual(envelopeAccessDenial(PLATFORM, t2, 'org_t1'), {
    status: 404,
    error: 'not found',
  });
  assert.deepEqual(envelopeAccessDenial(PLATFORM, t1, 'bad id!'), {
    status: 400,
    error: 'orgId is not a valid org id',
  });
});

test('a pinned consumer is confined to its pin but keeps its pre-v0.2 envelopes', () => {
  const mine = { createdBy: 'consumer:acme', orgId: 'org_abc' };
  const other = { createdBy: 'consumer:acme', orgId: 'org_other' };
  const legacy = { createdBy: 'consumer:acme' }; // stored before v0.2: no orgId
  assert.equal(envelopeAccessDenial(PINNED, mine, null), null);
  assert.equal(envelopeAccessDenial(PINNED, legacy, null), null);
  assert.deepEqual(envelopeAccessDenial(PINNED, other, null), { status: 404, error: 'not found' });
  assert.equal(envelopeAccessDenial(PINNED, mine, 'org_abc'), null);
  assert.deepEqual(envelopeAccessDenial(PINNED, legacy, 'org_abc'), {
    status: 404,
    error: 'not found',
  });
});

test('a sender may narrow to one org and is otherwise unscoped', () => {
  const e = { createdBy: 'consumer:redoffice', orgId: 'org_t1' };
  assert.equal(envelopeAccessDenial(SENDER, e, null), null);
  assert.equal(envelopeAccessDenial(SENDER, e, 'org_t1'), null);
  assert.deepEqual(envelopeAccessDenial(SENDER, e, 'org_t2'), { status: 404, error: 'not found' });
});

test('orgScopeFilter narrows a list the same way the read gate narrows one envelope', () => {
  assert.deepEqual(orgScopeFilter(SENDER, null), { filter: {}, error: null });
  assert.deepEqual(orgScopeFilter(SENDER, 'org_t1'), { filter: { orgId: 'org_t1' }, error: null });
  assert.deepEqual(orgScopeFilter(PLAIN, null), { filter: {}, error: null });
  assert.deepEqual(orgScopeFilter(PLATFORM, 'org_t1'), {
    filter: { orgId: 'org_t1' },
    error: null,
  });
  const missing = orgScopeFilter(PLATFORM, null);
  assert.equal(missing.filter, null);
  assert.equal(missing.error?.status, 400);
  assert.deepEqual(orgScopeFilter(PINNED, null), {
    filter: { orgId: { $in: ['org_abc', null] } },
    error: null,
  });
  assert.deepEqual(orgScopeFilter(PINNED, 'org_abc'), {
    filter: { orgId: { $in: ['org_abc', null] } },
    error: null,
  });
  const mismatch = orgScopeFilter(PINNED, 'org_victim');
  assert.equal(mismatch.filter, null);
  assert.equal(mismatch.error?.status, 400);
  const malformed = orgScopeFilter(SENDER, 'bad id!');
  assert.equal(malformed.filter, null);
  assert.equal(malformed.error?.status, 400);
});
