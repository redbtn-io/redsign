import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPdfUrlFromQuery } from './pdfUrl.ts';

const ORIGIN = 'https://redsign.example';

test('returns the doc query param when it is a same-origin path', () => {
  assert.equal(
    getPdfUrlFromQuery('?doc=%2Ffiles%2Fcontract.pdf', ORIGIN),
    '/files/contract.pdf',
  );
});

test('returns a same-origin absolute URL unchanged', () => {
  assert.equal(
    getPdfUrlFromQuery('?doc=https%3A%2F%2Fredsign.example%2Ffiles%2Fa.pdf', ORIGIN),
    'https://redsign.example/files/a.pdf',
  );
});

test('returns a bare same-origin relative filename', () => {
  assert.equal(getPdfUrlFromQuery('?doc=contract.pdf', ORIGIN), 'contract.pdf');
});

test('returns null when no doc query param is present', () => {
  assert.equal(getPdfUrlFromQuery('', ORIGIN), null);
  assert.equal(getPdfUrlFromQuery('?other=1', ORIGIN), null);
});

test('does not fabricate a fallback URL', () => {
  // Regression test: PDFSigner previously defaulted to a hardcoded
  // devcontainer path ('/workspaces/redsign/By-Laws.pdf') when no
  // ?doc= param was present, which made the "Document Not Found"
  // state unreachable and pointed at a path that doesn't exist in
  // the deployed app.
  const result = getPdfUrlFromQuery('', ORIGIN);
  assert.notEqual(result, '/workspaces/redsign/By-Laws.pdf');
  assert.equal(result, null);
});

// --- Security regression tests -------------------------------------------
// The `doc` value flows directly into react-pdf's <Document file={...}>,
// which fetches and renders it. Without validation an attacker can craft a
// redsign signing link (e.g. /sign?doc=https://evil.tld/anything.pdf) that
// makes the app fetch and display arbitrary attacker-controlled content
// from any origin under the redsign UI -- a document-authenticity /
// arbitrary-remote-fetch surface. `doc` must be restricted to same-origin
// http(s) references only (the app's own hosted documents).

test('rejects a cross-origin absolute URL', () => {
  assert.equal(
    getPdfUrlFromQuery('?doc=https%3A%2F%2Fevil.tld%2Fx.pdf', ORIGIN),
    null,
  );
});

test('rejects a protocol-relative URL pointing off-origin', () => {
  assert.equal(getPdfUrlFromQuery('?doc=%2F%2Fevil.tld%2Fx.pdf', ORIGIN), null);
});

test('rejects backslash-obfuscated off-origin URLs', () => {
  assert.equal(getPdfUrlFromQuery('?doc=%2F%5Cevil.tld%2Fx.pdf', ORIGIN), null);
  assert.equal(getPdfUrlFromQuery('?doc=%5C%5Cevil.tld%2Fx.pdf', ORIGIN), null);
});

test('rejects a userinfo-smuggled off-origin URL', () => {
  assert.equal(
    getPdfUrlFromQuery('?doc=https%3A%2F%2Fredsign.example%40evil.tld%2Fx.pdf', ORIGIN),
    null,
  );
});

test('rejects javascript: and data: schemes', () => {
  assert.equal(getPdfUrlFromQuery('?doc=javascript%3Aalert(1)', ORIGIN), null);
  assert.equal(
    getPdfUrlFromQuery('?doc=data%3Aapplication%2Fpdf%3Bbase64%2CAAAA', ORIGIN),
    null,
  );
});

test('rejects when there is no trusted base origin to validate against', () => {
  assert.equal(getPdfUrlFromQuery('?doc=%2Ffiles%2Fcontract.pdf', null), null);
});
