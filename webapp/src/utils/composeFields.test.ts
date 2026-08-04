import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SIGNERS,
  SIGNER_COLORS,
  buildEnvelopePayload,
  clamp01,
  composeValidationError,
  defaultFieldRect,
  firstName,
  pxToRel,
  relToPx,
  signerColor,
} from './composeFields.ts';
import type { ComposeField, ComposeSigner } from './composeFields.ts';

const PAGE = { width: 600, height: 800 };

function signer(id: string, name = 'Ada Lovelace', email = ''): ComposeSigner {
  return { id, name, email };
}

function field(id: string, signerId: string, overrides: Partial<ComposeField> = {}): ComposeField {
  return {
    id,
    type: 'signature',
    page: 1,
    x: 0.1,
    y: 0.2,
    w: 0.25,
    h: 0.06,
    signerId,
    ...overrides,
  };
}

test('pxToRel converts a pixel rect to page-relative 0..1', () => {
  const rel = pxToRel({ x: 60, y: 200, w: 150, h: 48 }, PAGE);
  assert.deepEqual(rel, { x: 0.1, y: 0.25, w: 0.25, h: 0.06 });
});

test('pxToRel clamps boxes dragged past the page edge fully back on-page', () => {
  const rel = pxToRel({ x: 590, y: 790, w: 150, h: 48 }, PAGE);
  assert.equal(rel.x, 0.75); // 1 - w
  assert.equal(rel.y, 0.94); // 1 - h
  assert.ok(rel.x + rel.w <= 1);
  assert.ok(rel.y + rel.h <= 1);
});

test('pxToRel never emits values outside 0..1 for garbage input', () => {
  const rel = pxToRel({ x: -50, y: NaN, w: 5000, h: -3 }, PAGE);
  for (const v of [rel.x, rel.y, rel.w, rel.h]) {
    assert.ok(v >= 0 && v <= 1, `expected 0..1, got ${v}`);
  }
});

test('relToPx round-trips with pxToRel', () => {
  const rel = { x: 0.325, y: 0.4, w: 0.25, h: 0.06 };
  const px = relToPx(rel, PAGE);
  assert.deepEqual(pxToRel(px, PAGE), rel);
});

test('clamp01 bounds and rejects non-finite values', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(Infinity), 0);
});

test('defaultFieldRect cascades drops and stays in bounds', () => {
  const first = defaultFieldRect('signature', 0);
  const second = defaultFieldRect('signature', 1);
  assert.notDeepEqual(first, second);
  for (const r of [first, second, defaultFieldRect('date', 7)]) {
    assert.ok(r.x >= 0 && r.x + r.w <= 1);
    assert.ok(r.y >= 0 && r.y + r.h <= 1);
  }
});

test('signerColor gives each of the 10 signer slots a distinct color', () => {
  const colors = new Set(Array.from({ length: MAX_SIGNERS }, (_, i) => signerColor(i)));
  assert.equal(colors.size, SIGNER_COLORS.length);
  assert.equal(signerColor(MAX_SIGNERS), signerColor(0)); // wraps, never throws
});

test('firstName falls back to a slot label for blank names', () => {
  assert.equal(firstName('Ada Lovelace', 0), 'Ada');
  assert.equal(firstName('  ', 2), 'Signer 3');
});

test('buildEnvelopePayload maps signerId -> signerIdx and trims signer data', () => {
  const s1 = signer('a', '  Ada Lovelace  ', ' ada@example.com ');
  const s2 = signer('b', 'Grace Hopper');
  const payload = buildEnvelopePayload([s1, s2], [field('f1', 'b'), field('f2', 'a')]);
  assert.deepEqual(payload.signers, [
    { name: 'Ada Lovelace', email: 'ada@example.com' },
    { name: 'Grace Hopper' },
  ]);
  assert.equal(payload.fields[0].signerIdx, 1);
  assert.equal(payload.fields[1].signerIdx, 0);
  assert.equal(payload.metadata.source, 'composer');
});

test('buildEnvelopePayload drops fields whose signer was removed and merges metadata', () => {
  const payload = buildEnvelopePayload(
    [signer('a')],
    [field('f1', 'a'), field('f2', 'ghost')],
    { e2e: true },
  );
  assert.equal(payload.fields.length, 1);
  assert.equal(payload.metadata.e2e, true);
  assert.equal(payload.metadata.source, 'composer');
});

test('composeValidationError enforces names and at least one live field', () => {
  assert.equal(composeValidationError([], []), 'Add at least one signer.');
  assert.equal(
    composeValidationError([signer('a', '')], [field('f', 'a')]),
    'Every signer needs a name.',
  );
  assert.equal(
    composeValidationError([signer('a')], [field('f', 'ghost')]),
    'Place at least one field on the document.',
  );
  assert.equal(composeValidationError([signer('a')], [field('f', 'a')]), null);
});
