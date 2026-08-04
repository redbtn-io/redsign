import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SIGNATURE_IMAGE_BYTES,
  fieldValueError,
  fitImageInBox,
  isCheckedValue,
  isValidSigningToken,
  missingRequiredKeys,
  relRectToPdf,
  signerFieldEntries,
  signingTurn,
  type SignField,
  type TurnSigner,
} from './signing.ts';

// --- token shape ---

test('isValidSigningToken accepts exactly 48 lowercase hex chars', () => {
  assert.equal(isValidSigningToken('a'.repeat(48)), true);
  assert.equal(isValidSigningToken('0123456789abcdef'.repeat(3)), true);
});

test('isValidSigningToken rejects wrong length, case, charset, and non-strings', () => {
  assert.equal(isValidSigningToken('a'.repeat(47)), false);
  assert.equal(isValidSigningToken('a'.repeat(49)), false);
  assert.equal(isValidSigningToken('A'.repeat(48)), false);
  assert.equal(isValidSigningToken('g'.repeat(48)), false);
  assert.equal(isValidSigningToken(''), false);
  assert.equal(isValidSigningToken(null), false);
  assert.equal(isValidSigningToken(42), false);
});

// --- sequential ordering ---

function signer(idx: number, status: string, order?: number): TurnSigner {
  return { idx, name: `Signer ${idx}`, status, order };
}

test('signingTurn: first signer of a sent envelope can sign', () => {
  const signers = [signer(0, 'pending', 0), signer(1, 'pending', 1)];
  assert.deepEqual(signingTurn('sent', signers, 0), { canSign: true, waitingOn: null });
});

test('signingTurn: later signer waits on the earliest unsigned blocker', () => {
  const signers = [signer(0, 'pending', 0), signer(1, 'pending', 1), signer(2, 'pending', 2)];
  assert.deepEqual(signingTurn('sent', signers, 2), { canSign: false, waitingOn: 'Signer 0' });
  assert.deepEqual(signingTurn('sent', signers, 1), { canSign: false, waitingOn: 'Signer 0' });
});

test('signingTurn: unblocks once every lower-order signer signed', () => {
  const signers = [signer(0, 'signed', 0), signer(1, 'pending', 1)];
  assert.deepEqual(signingTurn('sent', signers, 1), { canSign: true, waitingOn: null });
});

test('signingTurn: order ties break by idx', () => {
  const signers = [signer(0, 'pending', 0), signer(1, 'pending', 0)];
  assert.deepEqual(signingTurn('sent', signers, 0), { canSign: true, waitingOn: null });
  assert.deepEqual(signingTurn('sent', signers, 1), { canSign: false, waitingOn: 'Signer 0' });
});

test('signingTurn: explicit order beats idx order', () => {
  // signer 1 goes first (order 0), signer 0 second (order 1)
  const signers = [signer(0, 'pending', 1), signer(1, 'pending', 0)];
  assert.deepEqual(signingTurn('sent', signers, 1), { canSign: true, waitingOn: null });
  assert.deepEqual(signingTurn('sent', signers, 0), { canSign: false, waitingOn: 'Signer 1' });
});

test('signingTurn: missing order falls back to idx', () => {
  const signers = [signer(0, 'pending'), signer(1, 'pending')];
  assert.deepEqual(signingTurn('sent', signers, 1), { canSign: false, waitingOn: 'Signer 0' });
});

test('signingTurn: never canSign unless envelope is sent', () => {
  for (const status of ['draft', 'completed', 'voided', 'declined']) {
    const signers = [signer(0, 'pending', 0)];
    assert.equal(signingTurn(status, signers, 0).canSign, false, status);
  }
});

test('signingTurn: an already-signed signer cannot sign again', () => {
  const signers = [signer(0, 'signed', 0), signer(1, 'pending', 1)];
  assert.equal(signingTurn('sent', signers, 0).canSign, false);
});

test('signingTurn: unknown idx cannot sign', () => {
  assert.deepEqual(signingTurn('sent', [signer(0, 'pending', 0)], 9), {
    canSign: false,
    waitingOn: null,
  });
});

// --- field entries + required values ---

const FIELDS: SignField[] = [
  { type: 'signature', page: 1, x: 0.1, y: 0.1, w: 0.25, h: 0.06, signerIdx: 0 },
  { type: 'date', page: 1, x: 0.1, y: 0.2, w: 0.18, h: 0.045, signerIdx: 0, required: false },
  { type: 'signature', page: 2, x: 0.5, y: 0.1, w: 0.25, h: 0.06, signerIdx: 1 },
  { type: 'text', page: 2, x: 0.5, y: 0.3, w: 0.2, h: 0.04, signerIdx: 0 },
];

test('signerFieldEntries keys fields by their absolute index in envelope.fields', () => {
  assert.deepEqual(
    signerFieldEntries(FIELDS, 0).map((e) => e.key),
    ['0', '1', '3']
  );
  assert.deepEqual(
    signerFieldEntries(FIELDS, 1).map((e) => e.key),
    ['2']
  );
});

test('missingRequiredKeys lists unfilled required fields only', () => {
  // Nothing filled: signature (0) and text (3) required; date (1) is optional.
  assert.deepEqual(missingRequiredKeys(FIELDS, 0, {}), ['0', '3']);
  // Whitespace does not count as filled.
  assert.deepEqual(missingRequiredKeys(FIELDS, 0, { '0': '  ', '3': 'ok' }), ['0']);
  // All required present.
  assert.deepEqual(missingRequiredKeys(FIELDS, 0, { '0': 'data:x', '3': 'hi' }), []);
  // Other signer's fields never count.
  assert.deepEqual(missingRequiredKeys(FIELDS, 1, { '2': 'data:x' }), []);
});

// --- value validation ---

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

test('fieldValueError: signatures must be PNG data URLs under 1MB', () => {
  assert.equal(fieldValueError('signature', PNG), null);
  assert.equal(fieldValueError('initials', PNG), null);
  assert.notEqual(fieldValueError('signature', 'hello'), null);
  assert.notEqual(fieldValueError('signature', 'data:image/jpeg;base64,AAAA'), null);
  assert.notEqual(fieldValueError('signature', 'data:image/png;base64,????'), null);
  const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_SIGNATURE_IMAGE_BYTES);
  assert.equal(fieldValueError('signature', huge), 'image exceeds 1MB');
});

test('fieldValueError: text/date capped at 500 chars', () => {
  assert.equal(fieldValueError('text', 'fine'), null);
  assert.equal(fieldValueError('date', 'Aug 4, 2026'), null);
  assert.notEqual(fieldValueError('text', 'x'.repeat(501)), null);
});

test('isCheckedValue recognizes common truthy forms only', () => {
  for (const v of ['true', 'on', '1', 'yes', 'checked', 'x', ' TRUE ']) {
    assert.equal(isCheckedValue(v), true, v);
  }
  for (const v of ['', 'false', 'off', '0', 'no']) {
    assert.equal(isCheckedValue(v), false, v);
  }
});

// --- flatten coordinate math ---

test('relRectToPdf flips the y axis (top-left rel -> bottom-left PDF points)', () => {
  // A field at the very top of a 612x792 page lands near y=792 in PDF space.
  const top = relRectToPdf({ x: 0, y: 0, w: 0.5, h: 0.1 }, 612, 792);
  assert.deepEqual(top, { x: 0, y: 792 - 79.2, w: 306, h: 79.2 });
  // A field at the very bottom lands at y=0.
  const bottom = relRectToPdf({ x: 0.5, y: 0.9, w: 0.5, h: 0.1 }, 612, 792);
  assert.equal(Math.round(bottom.y * 1000) / 1000, 0);
  assert.equal(bottom.x, 306);
});

test('relRectToPdf: full-page rect maps to the full page', () => {
  const r = relRectToPdf({ x: 0, y: 0, w: 1, h: 1 }, 500, 700);
  assert.deepEqual(r, { x: 0, y: 0, w: 500, h: 700 });
});

test('relRectToPdf scales with page size', () => {
  const a4 = relRectToPdf({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 595, 842);
  assert.equal(a4.x, 595 * 0.25);
  assert.equal(a4.w, 595 * 0.5);
  assert.equal(a4.h, 842 * 0.25);
  assert.equal(a4.y, 842 - (0.5 + 0.25) * 842);
});

test('fitImageInBox letterboxes wide images and centers them', () => {
  // 400x100 image into a 100x100 box -> 100x25, vertically centered.
  const fit = fitImageInBox(400, 100, { x: 10, y: 20, w: 100, h: 100 });
  assert.deepEqual(fit, { x: 10, y: 20 + 37.5, w: 100, h: 25 });
});

test('fitImageInBox letterboxes tall images and centers them', () => {
  const fit = fitImageInBox(100, 400, { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(fit, { x: (200 - 25) / 2, y: 0, w: 25, h: 100 });
});

test('fitImageInBox degrades to zero size on degenerate input', () => {
  assert.deepEqual(fitImageInBox(0, 100, { x: 1, y: 2, w: 10, h: 10 }), { x: 1, y: 2, w: 0, h: 0 });
});
