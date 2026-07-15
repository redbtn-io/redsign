import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPdfUrlFromQuery } from './pdfUrl.ts';

test('returns the doc query param when present', () => {
  assert.equal(getPdfUrlFromQuery('?doc=%2Ffiles%2Fcontract.pdf'), '/files/contract.pdf');
});

test('returns null when no doc query param is present', () => {
  assert.equal(getPdfUrlFromQuery(''), null);
  assert.equal(getPdfUrlFromQuery('?other=1'), null);
});

test('does not fabricate a fallback URL', () => {
  // Regression test: PDFSigner previously defaulted to a hardcoded
  // devcontainer path ('/workspaces/redsign/By-Laws.pdf') when no
  // ?doc= param was present, which made the "Document Not Found"
  // state unreachable and pointed at a path that doesn't exist in
  // the deployed app.
  const result = getPdfUrlFromQuery('');
  assert.notEqual(result, '/workspaces/redsign/By-Laws.pdf');
  assert.equal(result, null);
});
