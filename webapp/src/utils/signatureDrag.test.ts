import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOpenSignatureModal } from './signatureDrag.ts';

test('does not open modal after a real drag', () => {
  const start = { x: 10, y: 15 };
  const moved = { x: 28.2, y: 16 };
  assert.equal(shouldOpenSignatureModal(start, moved), false);
});

test('opens modal only when pointer movement is a tiny click jitter', () => {
  const start = { x: 10, y: 15 };
  const jitter = { x: 10.05, y: 15.04 };
  assert.equal(shouldOpenSignatureModal(start, jitter), true);
});

test('supports configurable threshold boundaries', () => {
  const start = { x: 10, y: 15 };
  const nearBoundary = { x: 10.08, y: 15.0 };
  assert.equal(shouldOpenSignatureModal(start, nearBoundary), true);
  assert.equal(shouldOpenSignatureModal(start, nearBoundary, 0.05), false);
});
