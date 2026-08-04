# redSign Envelope API — integration contract (v0)

Status: **adopted 2026-08-03** (George approved the recommendations on the four
open calls). Written from the consumer side; redFinance is the first customer.
Implemented through Phase 3 (envelope API core, sender compose flow, public
signing + flattening); webhooks are still pending. When reality diverges
during the build, update this doc in the same PR.

## Context: redSuite

redSign is the signatures pillar of **redSuite** (redNote, redDoc, redSign,
redMeet, ...). It is a standalone product, not an internal library. Other
products integrate **horizontally** over HTTP: create envelopes, receive
webhooks, fetch executed PDFs. No consumer embeds redSign UI code. This doc
doubles as the reference pattern for how non-suite products consume suite
services.

- redSign is the system of record for **envelopes and signature certificates**.
- Each consumer stays the system of record for its own **documents** (redFinance
  keeps its immutable archive; it stores the executed PDF it fetches back).

## Core objects

- **Envelope** `{ id, status: draft|sent|completed|declined|voided, document,
  signers[], fields[], metadata, webhookUrl, createdBy, completedAt }`
- **Signer** `{ idx, name, email?, phone?, order, status, signedAt, consentAt,
  ip, userAgent }` — each signer gets an unguessable signing link.
- **Field** `{ type: signature|initials|date|text|checkbox, page, x, y, w, h,
  signerIdx, required }` — coordinates page-relative (0..1) so they survive
  render scaling. The existing drag-place UX already produces these.
- **Certificate**: audit page appended to the executed PDF (who, when, IP,
  consent) + the same data as JSON via the API.

## Endpoints (v0)

| Call | Purpose |
|---|---|
| `POST /api/envelopes` | multipart PDF + JSON `{signers, fields, metadata, webhookUrl}` → `{envelopeId, signers: [{idx, signingUrl}]}` |
| `GET /api/envelopes/:id` | envelope + live status |
| `GET /api/envelopes/:id/document` | current (or executed) PDF |
| `POST /api/envelopes/:id/void` | cancel |
| `GET /sign/:signerToken` | public signing page (standalone, mobile-first) |
| `GET /api/sign/:signerToken` | public signer state (JSON, token-guarded) |
| `GET /api/sign/:signerToken/document` | streams the ORIGINAL PDF inline |
| `POST /api/sign/:signerToken/complete` | records consent + field values, signs |

### Public signing API (Phase 3 — shipped 2026-08-04)

Token-guarded, no other auth: the 48-hex signer token (`/^[a-f0-9]{48}$/`) IS
the credential. Middleware exempts `/sign/` + `/api/sign/` outright. Unknown
AND voided tokens both return **404** — the JSON body's `error` field
distinguishes them (`"not found"` vs `"voided"`) so the page can explain a
void without the endpoint confirming live envelopes to token guessers.

- `GET /api/sign/:token` → `{ envelope: {documentName, status}, signer:
  {idx, name, status}, fields, canSign, waitingOn }`. `fields` contains ONLY
  this signer's fields, each with a `key` — the field's absolute index in
  `envelope.fields` (fields have no ids; this is their stable identity).
  `canSign` is false unless envelope status is `sent`, the signer is still
  `pending`, and every lower-order signer (ties broken by `idx`) has signed;
  `waitingOn` names the first blocking signer or is null.
- `GET /api/sign/:token/document` streams the original PDF inline — never
  the executed copy; the sender distributes the signed document.
- `POST /api/sign/:token/complete` with `{ consent: true, values: { [key]:
  value } }`. 409 when it is not the signer's turn or they already signed
  (sequential ordering is enforced server-side, atomically); 400 when
  `consent !== true` or a required field is missing. Signature/initials
  values are PNG data URLs (≤1MB each, ≤10MB per request); date/text ≤500
  chars. Values are stored on the signer inside the envelope document (not
  GridFS — 1-10 signers × ≤1MB stays far under Mongo's 16MB doc cap; GridFS
  holds only PDFs). Signing records `signedAt`, `consentAt`, `ip` (first
  X-Forwarded-For value), `userAgent`.

When the last signer completes, the envelope flips `sent → completed`
(single atomic winner), the original is flattened with pdf-lib — signature/
initials drawn as embedded PNGs, date/text as text, checkbox as X, at their
page-relative 0..1 coords — and a **certificate page** is appended: envelope
id, document name + SHA-256 of the original, per-signer name/consentAt/
signedAt/ip/userAgent, completion timestamp, "Executed via redSign ·
sign.redbtn.io". The executed PDF lands in GridFS (`pdfs` bucket,
`{kind:'executed'}`) and `executedFileId` is set; `GET
/api/envelopes/:id/document` then serves the executed copy first.

Divergence note: v0 planned "the existing prototype UX" for `/sign/:token`;
what shipped is a purpose-built standalone mobile-first page (no sender
shell) that reuses the prototype's SignatureCanvas capture. Webhooks
(`sent/viewed/signed/...`) are still **not implemented** — the dispatcher
remains future work.

Webhooks: POST to the consumer's `webhookUrl` on `sent / viewed / signed /
completed / declined / voided` with `{event, envelopeId, signerIdx?, at,
metadata}` and header `X-RedSign-Signature` (HMAC-SHA256, shared secret).
Retry with backoff on non-2xx.

## Auth planes (suite conventions)

- **Senders (humans)**: redauth `red_session` cookie, domain-wide `.redbtn.io`
  (same middleware recipe redFinance ships today).
- **Machine consumers**: per-consumer service key header (`x-redsign-key`),
  issued per app. redFinance's key lives in its `appConfig.env`.
- **Signers (external people)**: 48-hex token links, no account required.
  Consent checkbox + timestamp + IP recorded on sign (ESIGN basics).

## Backend needed to get the prototype there

Mongo `redsign` DB, PDF storage (GridFS), server-side field flattening +
certificate page (pdf-lib), webhook dispatcher, redauth middleware, RedRun
workspace + `sign.redbtn.io`.

## First consumer: redFinance (its Phase 5, blocked on this API)

1. **Contractor agreement**: redFinance posts an envelope (agreement PDF,
   signer = contractor, metadata `{contractorId, kind: "agreement"}`), surfaces
   the signingUrl on the contractor's existing portal, and on the `completed`
   webhook stores the executed PDF in its archive with a number, logs the
   event, DMs George. Compliance engine gains an "agreement on file" rule
   beside the W-9 rule.
2. **Pre-filled W-9**: redFinance generates a filled W-9 PDF from registry
   data, sends it for signature, and on completion flips `w9Status` — the
   print/scan step dies.
3. **Statement signatures**: George's stored signature auto-applies as a sender
   field at issue; optional contractor acknowledgment field.

redFinance's consumer-side work: a small client lib, an HMAC-verified webhook
receiver, "Sign" buttons on the portal, archive integration.

## v0 decisions (adopted 2026-08-03)

1. **PDF-only v0.** Consumers own HTML→PDF; redSign accepts and produces PDFs.
2. **Domain: `sign.redbtn.io`** (suite convention; custom domain later).
3. **Per-consumer service keys** (`x-redsign-key`), issued and revocable per
   app. INTERNAL_SERVICE_KEY is not reused.
4. **Consumers deliver signer links in v0.** Native email/SMS delivery is a v1
   feature for non-redbtn customers.
