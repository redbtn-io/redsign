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

test('rejects same-origin documents that are not PDFs', () => {
  assert.equal(getPdfUrlFromQuery('?doc=%2Ffiles%2Fcontract.png', ORIGIN), null);
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

// --- Extended security regression coverage --------------------------------
// The guard above is the app's only server-independent security boundary: the
// `doc` value flows into <Document file={...}>. The cases below lock in vectors
// the original suite did not exercise. Each was chosen because a *plausible*
// rewrite of the guard would silently re-admit it — verified by running this
// suite against regressed implementations:
//   * dropping the http(s) protocol allowlist  -> `blob:` case + INVARIANT fail
//   * a substring hostname check (includes/endsWith) -> `http downgrade` +
//     `look-alike suffix host` cases + INVARIANT fail
//   * removing validation entirely -> the whole block fails
// `q()` encodes the raw attacker string so control-char vectors stay legible.
const q = (doc: string) => '?doc=' + encodeURIComponent(doc);

test('rejects a mixed-content http downgrade of the same host', () => {
  // Served over https://redsign.example, an http:// ref is a different origin
  // (scheme is part of the origin) and must not be fetched.
  assert.equal(getPdfUrlFromQuery(q('http://redsign.example/x.pdf'), ORIGIN), null);
});

test('rejects non-http(s) schemes beyond javascript:/data:', () => {
  assert.equal(getPdfUrlFromQuery(q('blob:https://redsign.example/uuid'), ORIGIN), null);
  assert.equal(getPdfUrlFromQuery(q('file:///etc/passwd'), ORIGIN), null);
  assert.equal(getPdfUrlFromQuery(q('filesystem:https://redsign.example/temporary/x'), ORIGIN), null);
  assert.equal(getPdfUrlFromQuery(q('vbscript:msgbox(1)'), ORIGIN), null);
});

test('rejects whitespace/control-char-obfuscated off-origin refs', () => {
  // WHATWG URL strips leading/embedded tab, newline and space; the guard must
  // still see the underlying protocol-relative off-origin target and reject it.
  assert.equal(getPdfUrlFromQuery(q('\t//evil.tld/x.pdf'), ORIGIN), null);
  assert.equal(getPdfUrlFromQuery(q(' //evil.tld/x.pdf'), ORIGIN), null);
  assert.equal(getPdfUrlFromQuery(q('\n//evil.tld/x.pdf'), ORIGIN), null);
  assert.equal(getPdfUrlFromQuery(q('///evil.tld/x.pdf'), ORIGIN), null);
});

test('rejects a look-alike host that only shares a prefix/suffix', () => {
  assert.equal(getPdfUrlFromQuery(q('https://redsign.example.evil.tld/x.pdf'), ORIGIN), null);
  assert.equal(getPdfUrlFromQuery(q('https://not-redsign.example/x.pdf'), ORIGIN), null);
  assert.equal(getPdfUrlFromQuery(q('https://redsign.example%2f@evil.tld/x.pdf'), ORIGIN), null);
});

test('accepts a same-origin ref whose scheme/host is upper-cased', () => {
  // URL normalization lower-cases scheme + host; this must stay same-origin.
  assert.notEqual(getPdfUrlFromQuery(q('HTTPS://REDSIGN.EXAMPLE/x.pdf'), ORIGIN), null);
});

test('INVARIANT: any accepted doc resolves to a same-origin http(s) URL in the browser', () => {
  // react-pdf/pdf.js resolve <Document file={raw}> against document.baseURI
  // (the current page URL), NOT against the bare origin the guard validated.
  // This asserts the property that actually matters: whatever the guard hands
  // back can only ever fetch a same-origin http(s) document.
  const PAGE_URL = 'https://redsign.example/sign';
  const battery = [
    // off-origin / dangerous — must be dropped
    'https://evil.tld/x.pdf', '//evil.tld/x.pdf', '/\\evil.tld/x.pdf',
    '\\\\evil.tld/x.pdf', 'https://redsign.example@evil.tld/x.pdf',
    'http://redsign.example/x.pdf', 'blob:https://redsign.example/uuid',
    'file:///etc/passwd', 'javascript:alert(1)', 'data:application/pdf;base64,AAAA',
    'https://redsign.example.evil.tld/x.pdf', '\t//evil.tld/x.pdf', '///evil.tld/x.pdf',
    // scheme-relative / odd-but-same-origin forms — safe to accept, must stay same-origin
    'https:evil.tld/x.pdf', '@evil.tld/x.pdf', '/%2F%2Fevil.tld/x.pdf',
    // legitimate same-origin docs
    '/files/a.pdf', 'contract.pdf', 'https://redsign.example/files/a.pdf',
  ];
  for (const raw of battery) {
    const out = getPdfUrlFromQuery(q(raw), ORIGIN);
    if (out === null) continue;
    const resolved = new URL(out, PAGE_URL);
    assert.ok(
      resolved.protocol === 'http:' || resolved.protocol === 'https:',
      `accepted ${JSON.stringify(raw)} -> ${JSON.stringify(out)} has non-http scheme ${resolved.protocol}`,
    );
    assert.equal(
      resolved.origin,
      ORIGIN,
      `accepted ${JSON.stringify(raw)} -> ${JSON.stringify(out)} resolves off-origin: ${resolved.origin}`,
    );
  }
});
