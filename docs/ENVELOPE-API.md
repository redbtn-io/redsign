# redSign Envelope API — integration contract (v0)

Status: **adopted 2026-08-03** (George approved the recommendations on the four
open calls). Written from the consumer side; redFinance is the first customer.
Nothing here is implemented yet; this is the contract both sides build to. When
reality diverges during the build, update this doc in the same PR.

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
| `GET /sign/:signerToken` | public signing page (the existing prototype UX) |

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
