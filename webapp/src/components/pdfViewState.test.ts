import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNextPage } from './pdfViewState.ts';

test('does not advance page when total pages is unknown', () => {
  assert.equal(getNextPage(1, null), 1);
  assert.equal(getNextPage(3, null), 3);
});

test('advances to the requested next page until the upper bound', () => {
  assert.equal(getNextPage(1, 3), 2);
  assert.equal(getNextPage(3, 3), 3);
  assert.equal(getNextPage(4, 3), 3);
});
