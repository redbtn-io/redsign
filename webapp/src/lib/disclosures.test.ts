import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCLOSURE_VERSION,
  disclosureFor,
  disclosureKindFor,
  disclosureSha256,
  disclosureText,
} from './disclosures.ts';

test('disclosureKindFor picks the W-9 body from envelope metadata', () => {
  assert.equal(disclosureKindFor({ kind: 'w9' }), 'w9');
  assert.equal(disclosureKindFor({ kind: 'W-9' }), 'w9');
  assert.equal(disclosureKindFor({ kind: 'agreement' }), 'individual');
  assert.equal(disclosureKindFor({}), 'individual');
  assert.equal(disclosureKindFor(null), 'individual');
});

test('every individual signer gets the four ESIGN 7001(c) sections', () => {
  // 15 U.S.C. 7001(c) is not satisfied without these; v0 shipped a bare
  // checkbox with none of them behind it.
  const d = disclosureFor('individual');
  const headings = d.sections.map((s) => s.heading.toLowerCase()).join(' | ');
  assert.match(headings, /hardware and software/);
  assert.match(headings, /paper copy/);
  assert.match(headings, /withdrawing your consent/);
  assert.match(headings, /scope of your consent/);
  assert.equal(d.version, DISCLOSURE_VERSION);
});

test('the withdrawal section says how, that it is free, and what it does not undo', () => {
  const body = disclosureFor('individual').sections.find((s) =>
    /withdraw/i.test(s.heading)
  )!.body;
  assert.match(body, /at any time/i);
  assert.match(body, /no charge/i);
  assert.match(body, /does not undo a signature you already completed/i);
});

test('the requirements section names browser, internet and PDF', () => {
  const body = disclosureFor('individual').sections.find((s) =>
    /hardware and software/i.test(s.heading)
  )!.body;
  assert.match(body, /browser/i);
  assert.match(body, /internet/i);
  assert.match(body, /PDF/);
});

test('the W-9 body leads with the perjury certification and keeps the consumer sections', () => {
  const d = disclosureFor('w9');
  assert.match(d.sections[0].heading, /penalties of perjury/i);
  assert.match(d.sections[0].body, /under penalties of perjury/i);
  assert.match(d.sections[0].body, /backup withholding/i);
  assert.match(d.sections[0].body, /U\.S\. citizen or other U\.S\. person/);
  assert.match(d.acknowledgement, /penalties of perjury/i);
  // The consumer sections are additive, not replaced.
  assert.equal(d.sections.length, disclosureFor('individual').sections.length + 1);
});

test('the individual body carries no perjury language', () => {
  assert.doesNotMatch(disclosureText(disclosureFor('individual')), /perjury/i);
});

test('disclosureText is stable and disclosureSha256 tracks the text', () => {
  const a = disclosureFor('individual');
  assert.equal(disclosureSha256(a), disclosureSha256(disclosureFor('individual')));
  assert.notEqual(disclosureSha256(a), disclosureSha256(disclosureFor('w9')));
  assert.match(disclosureSha256(a), /^[0-9a-f]{64}$/);
  assert.ok(disclosureText(a).includes(DISCLOSURE_VERSION));
});
