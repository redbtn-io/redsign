# redSign Envelope API — integration contract (v0, extended by v0.2)

Status: **adopted 2026-08-03** (George approved the recommendations on the four
open calls). Written from the consumer side; redFinance is the first customer.
Implemented through Phase 4 (envelope API core, sender compose flow, public
signing + flattening, lifecycle events + signed webhooks + sender dashboard),
then extended by **v0.2** (see the v0.2 section at the end of this document,
which is where the current behaviour is defined wherever the two differ).
When reality diverges during the build, update this doc in the same PR.

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
| `GET /api/envelopes/:id/links` | signing URLs per signer (senders AND owning consumers — link recovery) |
| `GET /api/envelopes/:id/events` | lifecycle audit trail (newest first, max 100) |
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
shell) that reuses the prototype's SignatureCanvas capture.

### Lifecycle events + webhooks (Phase 4 — shipped 2026-08-04)

Every transition appends to an `envelope_events` audit collection (served by
`GET /api/envelopes/:id/events`, the dashboard's timeline) and, when the
envelope has a `webhookUrl`, POSTs to it:

- **Events**: `sent` (creation IS the sent transition in v0 — there is no
  draft step), `viewed` (first `GET /api/sign/:token` per signer, exactly
  once — an atomic compare-and-set on the signer's `viewedAt`), `signed`
  (each signer completion, with `signerIdx`), `completed` (emitted only
  after the executed PDF is in GridFS, so a consumer reacting to it can
  fetch `/document` and get the executed copy immediately), `voided`.
  `declined` is **reserved**: no decline flow ships in v0; the name is
  allocated so consumers can switch on it.
- **Payload**: JSON `{event, envelopeId, signerIdx?, at, metadata}` —
  `signerIdx` only on `viewed`/`signed`, `at` ISO-8601, `metadata` the
  envelope's metadata verbatim (this is how redFinance finds its
  `contractorId` again).
- **Signature**: header `X-RedSign-Signature: sha256=<hex>` = HMAC-SHA256 of
  the raw request body. Verify with a constant-time compare against your
  recomputation. Consumer-created envelopes are signed with that consumer's
  `webhookSecret` (stored retrievable on the consumers row — redSign must be
  able to compute the HMAC, so unlike the hashed service key it cannot be
  hashed; provisioned via `webapp/scripts/ensure-webhook-secret.mjs`, read
  out-of-band by the operator). Sender-created envelopes are signed with the
  deployment-wide `WEBHOOK_FALLBACK_SECRET` env. If no secret is available
  the delivery is recorded as `failed` and never sent — an unsigned webhook
  would train consumers to skip verification. The body is serialized and
  signed once at enqueue; every attempt POSTs those exact bytes.
- **Delivery + retry**: 10s timeout; non-2xx or network error retries with
  backoff **30s → 2m → 10m → 10m** (5 attempts total, then `failed`). No
  queue infra: deliveries persist in a `webhook_deliveries` collection
  `{envelopeId, event, url, body, sig, attempts, nextAttemptAt, status:
  pending|inflight|delivered|failed}`; the first attempt fires immediately
  (fire-and-forget from the transition), a 60s in-process sweep claims due
  rows atomically and retries. Deliveries are at-least-once and unordered
  under retries — consumers should treat `{envelopeId, event, signerIdx}` as
  idempotency key and rely on `at` for ordering.

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

---

# v0.2 (2026-09-05)

Status: **implemented, not yet deployed.** This section defines current
behaviour wherever it differs from v0 above. Nothing here changes the sender
auth plane: senders are still @redbtn.io humans holding a `red_session` cookie,
and tenant senders are explicitly not part of this version.

v0.2 exists to make redSign safe to hand a second, multi-tenant consumer
(redOffice) and to make a completed envelope hold up as a record rather than
just as a status. Everything below falls into one of those two buckets.

## What a v0 consumer has to change

Nothing, with two exceptions:

1. **`webhookUrl` must be https and on the allowlist.** An existing envelope
   keeps delivering to the URL it was created with; only *new* envelopes are
   validated. redFinance's `https://finance.redbtn.io/...` already passes.
2. **`signers[].values` no longer appears on envelope reads.** A consumer that
   was reading signature PNGs off `GET /api/envelopes/:id` moves to
   `GET /api/envelopes/:id/values`. No known consumer does this today.

The `completed` webhook payload gains one field (`executedSha256`). Payloads
for every other event are byte for byte what they were, so an existing HMAC
verifier keeps passing.

## New and changed endpoints

| Call | Change |
|---|---|
| `POST /api/envelopes` | accepts `expiresAt` / `expiresInDays` and `signers[].accessCode`; requires `metadata.orgId` from platform consumers; `webhookUrl` must be https and allowlisted; returns `expiresAt`, `documentSha256` and per-signer `accessCodeRequired` |
| `GET /api/envelopes` | `signers[].values` and `signers[].accessCodeHash` projected out |
| `GET /api/envelopes/:id` | same projection |
| `GET /api/envelopes/:id/values` | **new.** Owner-only. The one route that returns the collected field values, signature PNGs included |
| `GET /api/envelopes/:id/audit` | **new.** Owner-only. The complete certificate record: both digests, every signer's consent, every event in order with no limit, every webhook delivery outcome |
| `GET /api/envelopes/:id/events` | unchanged (newest first, capped at 100). It feeds the dashboard. `/audit` is the archival read |
| `GET /api/envelopes/:id/document` | adds an `X-RedSign-Sha256` response header carrying the digest of the bytes being served |
| `GET /api/envelopes/:id/links` | adds `expiresAt` and per-signer `accessCodeRequired` |
| `GET /api/sign/:token` | returns the `disclosure` to show before consent, plus `envelope.expiresAt` and `signer.consentAt`; answers 401 `{requiresAccessCode:true}` when a code is set and not presented; answers 404 `{error:"expired"}` on an expired envelope |
| `POST /api/sign/:token/consent` | **new.** Records consent at the moment it is given |
| `POST /api/sign/:token/complete` | records the consent inline only if `/consent` was not called; records `ipChain`; computes `executedSha256` at completion |
| `GET /api/health` | **no longer behind the auth gate** |

## Machine consumers: minting, platform flag, org assertion

`scripts/mint-consumer.mjs --name <consumer> [--platform | --org-id <id>]
[--rotate]` is the way a consumer is issued. It writes:

- `keyHash`, the SHA-256 of the `x-redsign-key` service key. Hashed, because
  redSign only ever compares it.
- `webhookSecretEnc`, the webhook HMAC key **AES-256-GCM encrypted** under
  `REDSIGN_SECRETS_KEY` (32 bytes, hex or base64, in the workspace env). It
  stays reversible rather than hashed because redSign has to compute the HMAC
  on outgoing bodies. v0 stored this in the clear, which put a live signing key
  into every database dump and backup of the collection. Rows still holding the
  v0 plaintext `webhookSecret` keep working and can be converted in place with
  `scripts/ensure-webhook-secret.mjs <name> --reencrypt`.
- `platform`, `orgId`, `active`.

Both credentials are printed once, at mint time, and are unrecoverable
afterwards. Generate and store `REDSIGN_SECRETS_KEY` **before** minting: rows
encrypted under a key that is then lost cannot sign webhooks.

A **platform consumer** (`platform: true`) is one credential serving many
tenants. redOffice is the first. Every envelope it creates must carry
`metadata.orgId`; creation answers 400 without it. A non-platform consumer is
single tenant and may pin its org on the row instead (`--org-id`), which is
copied onto the envelopes it creates.

**Directory validation is a documented hook, not yet a call.** The next version
validates the asserted `orgId` against redOffice's directory endpoint over HTTP
(redSign never connects to the `redorg` database itself). The call site,
including the intended request shape and the fail-closed rule for platform
consumers, is `assertOrgForConsumer` in `webapp/src/lib/policy.ts`. It
deliberately does nothing today: the directory does not exist yet, and a hook
that fails open would be worth nothing while one that fails closed would break
every platform send.

## Signature values are not part of an envelope read

`signers[].values` holds the collected field values, and for signature and
initials fields those are PNG images of a person's handwritten signature. They
are the one thing in an envelope directly reusable for forgery, so they no
longer ride along on a list or a status poll. Every envelope read projects them
out, next to the signer tokens that were already projected out, and
`GET /api/envelopes/:id/values` is the single deliberate way to them: owner
only, never cached, and distinct enough that "who pulled the signature images"
is answerable from access logs. `signers[].accessCodeHash` never leaves the
database at all.

## executedSha256

At completion, after the executed PDF is written to GridFS, redSign computes
the SHA-256 of exactly those bytes and publishes it in four places:

- `envelope.executedSha256`, on the envelope document and every envelope read;
- the `completed` **webhook payload**, which is the important one: the digest
  arrives over the HMAC-signed channel while the file arrives over a separate
  fetch, so a consumer can verify what it archived against a value that did not
  travel with it;
- `GET /api/envelopes/:id/audit`, the certificate record;
- the `X-RedSign-Sha256` header on `GET /api/envelopes/:id/document`.

`envelope.documentSha256` is the same thing for the original bytes, recorded at
send time.

**Why the printed certificate page does not carry it.** A file cannot contain
its own digest: adding the hash to the certificate page changes the bytes the
hash describes. The certificate page therefore prints the SHA-256 of the
original document (as it always did) and names where the executed digest is
published. Anyone who wants to verify the executed PDF hashes the file they
hold and compares it with the webhook or the audit record. The certificate also
gained the disclosure version and digest each signer agreed to, the signer's
email, and the forwarded IP chain.

## Consent, disclosures and what gets recorded

`POST /api/sign/:token/consent` with `{consent: true, disclosureVersion?}`.

v0 folded consent into the completion call as a bare `consent: true` boolean.
That is enough to gate a button and not enough to be evidence: nothing recorded
which disclosure the signer was shown, and the only timestamp was taken when
they finished signing, which is not when they agreed. 15 U.S.C. 7001(c) does
not make an electronic record satisfy a writing requirement for a consumer
unless that consumer was given the hardware and software requirements, told how
to get a paper copy, told how to withdraw consent, and then affirmatively
consented.

v0.2 pins the exact text (`webapp/src/lib/disclosures.ts`), versions it
(`DISCLOSURE_VERSION`, currently `2026-09-05.1`), serves it on
`GET /api/sign/:token` as `disclosure`, and records against the signer:

```
consentAt            server clock, at the moment of consent
consent.disclosureVersion
consent.disclosureKind      individual | w9
consent.disclosureSha256    digest of the exact text served
consent.ip, consent.ipChain, consent.ipSource
consent.userAgent
```

Two bodies of text:

- **individual** (every signer): scope of consent, hardware and software
  requirements, how to get a paper copy at no charge, how to withdraw consent
  and what withdrawal does and does not undo, keeping contact details current,
  and what redSign records.
- **w9** (selected when `metadata.kind` is `w9`): the individual sections plus
  the Form W-9 Part II certification under penalties of perjury, shown first,
  with an acknowledgement line that names it.

The route is idempotent: a second consent returns the first record rather than
moving the timestamp. It is a compare-and-set on the signer, so two racing
submissions record one. A `disclosureVersion` that does not match what the
server would serve today is refused with 409, so a page left open across a
wording change cannot record agreement to text the signer never saw.

Consent appends a `consent` row to the envelope's event trail and is
**deliberately not a webhook event**: it fires on a page the signer is still
sitting on, carries no state a consumer can act on, and would double every
consumer's delivery volume for no decision.

`POST /complete` still accepts `consent: true` on its own. A signer who reaches
it without having called `/consent` (an older client) gets the record written
inline from the same disclosure text, marked `recordedAt: "complete"`. A signer
who already consented keeps the earlier, correctly timed record.

## Client IP: CF-Connecting-IP with the forwarded chain

v0 recorded only the first `X-Forwarded-For` value. sign.redbtn.io sits behind
Cloudflare, then redrouter-proxy, then traefik, and each hop appends, so the
first value is whatever the outermost proxy was told, which a client can set
itself. v0.2 prefers `CF-Connecting-IP` (Cloudflare sets it from the real TCP
peer), falls back to the first `X-Forwarded-For` value and then `X-Real-IP`,
and stores the whole chain verbatim alongside the answer as `ipChain`
(`cf-connecting-ip=...; x-forwarded-for=...; x-real-ip=...`, bounded to 500
characters). An audit trail that shows only the conclusion cannot be checked.

## Optional signer access code

`signers[].accessCode` on creation (4 to 32 characters after spaces and dashes
are stripped, case insensitive) puts a second factor on the signing link. The
sender gives the code to the signer out of band, so an intercepted or forwarded
link is not enough on its own.

It is stored as HMAC-SHA256 keyed by that signer's own 48-hex token, so the
stored digest is useless to anyone who does not already hold the link and a
short human code is not brute forceable from a database dump alone. The
plaintext code is never stored and is not recoverable: `/links` and the create
response report only `accessCodeRequired`.

The signer presents it as the `x-redsign-access-code` header, or as `?code=`
where a custom header is impossible (the PDF fetch). Without it,
`GET /api/sign/:token` answers 401 with `{requiresAccessCode: true}` and the
signer's name and nothing else: no document name, no field list. `/document`,
`/consent` and `/complete` are gated the same way. A signing link that has not
been opened with its code is not recorded as `viewed`.

## Expiry applies to new envelopes only

`POST /api/envelopes` accepts `expiresAt` (ISO-8601, must be in the future and
within 365 days), `expiresInDays`, or `expiresAt: null` to opt out. Omitting it
sets the default window, 90 days, configurable per deployment with
`REDSIGN_DEFAULT_EXPIRY_DAYS`.

**Envelopes stored before v0.2 carry no `expiresAt` and are never expired.**
That asymmetry is deliberate and load bearing. Retrofitting a default onto
stored envelopes would silently kill signing links already sitting in people's
inboxes, including the pending W-9 envelope `6a96f5fad8f61708c97e7bc5`, which
must remain signable. A missing `expiresAt` means "never", not "expired", and
there is a test that says so.

An expired link answers 404 with `{error: "expired"}` on `/api/sign/:token`,
the same way a voided one answers `{error: "voided"}`. The envelope's status is
not rewritten: expiry is evaluated at access time, so extending an envelope is
a single field update rather than a state repair.

## webhookUrl: https and allowlisted

v0 accepted any `http(s)` URL, which made envelope creation a small egress
primitive for anyone holding a consumer key and allowed a plaintext endpoint
carrying envelope metadata in the clear. v0.2 requires:

- `https` only;
- no credentials embedded in the URL;
- a hostname, not an IP literal;
- a host on `REDSIGN_WEBHOOK_HOST_ALLOWLIST` (comma separated; an entry
  starting with `.` matches that domain and its subdomains). The default with
  nothing configured is `.redbtn.io`.

Validation happens at creation. Envelopes already stored keep delivering to
whatever they carry.

## /api/health is public

`GET /api/health` returns `{ok, db}` and is exempt from the sender gate. It was
behind it, so every uptime probe received a 401 interstitial and RedRun could
not distinguish "the app is up" from "the app is wedged". The route reports
liveness and a Mongo ping and nothing else. The exemption is an exact path
match plus segments below it, so a route merely starting with those characters
cannot inherit it.

## Data retention

redSign is the system of record for **envelopes and signature certificates**.
Each consumer stays the system of record for its own documents. What that means
in practice:

- **Envelope documents, events and executed PDFs are retained indefinitely** in
  the current version. There is no TTL index and no purge job. An executed
  envelope is the evidence that a signature happened, and the retention period
  that matters is the one the consumer's own record keeping requires, which
  redSign cannot know. A tax form signed under penalties of perjury is a
  four-year record for the payer; an agreement is usually kept for the term
  plus the limitation period.
- **The consumer is expected to fetch and archive the executed PDF** on the
  `completed` webhook, verify it against `executedSha256`, and store the audit
  record from `GET /api/envelopes/:id/audit` beside it. That archive, not
  redSign, is what the consumer should rely on for its own retention
  obligations. redSign's copy is a convenience and a cross-check.
- **Deletion is manual and deliberate.** There is no delete endpoint. Voiding
  an envelope stops it being signable and keeps the record. Removing an
  envelope, for example on a documented erasure request, is an operator action
  against the database, and it must remove the envelope document, its
  `envelope_events` rows, its `webhook_deliveries` rows and both GridFS files.
  A signature certificate that outlives the document it certifies is worse than
  no certificate.
- **What is stored about a signer** is the name the sender supplied, an
  optional email and phone the sender supplied, the collected field values
  (signature images included), consent with its disclosure version and digest,
  view and sign timestamps, IP and forwarded chain, and user agent. redSign
  stores no taxpayer identification numbers: a W-9 sent through redSign carries
  the TIN inside the consumer's PDF, and the TIN never becomes a redSign field.
- **Signing tokens and access-code digests are never returned** by any read
  except `/links`, which returns signing URLs to the envelope's owner by
  design. Access codes themselves are not stored at all.
- **Webhook delivery rows retain the signed body** until they are deleted, so
  an operator debugging a consumer's verification failure can compare bytes.
  `/audit` projects the body and signature out.

A shorter retention policy, a TTL on `envelope_events`, or a per-consumer
retention setting are all reasonable next steps and none of them are in this
version. This section says what the code does today.

## v0.2 configuration

| Variable | Required | Purpose |
|---|---|---|
| `REDSIGN_SECRETS_KEY` | to mint or read an encrypted webhook secret | 32 bytes, hex or base64. Encrypts `consumers.webhookSecretEnc` |
| `REDSIGN_WEBHOOK_HOST_ALLOWLIST` | no | Comma separated. Defaults to `.redbtn.io` |
| `REDSIGN_DEFAULT_EXPIRY_DAYS` | no | Defaults to 90 |
| `REDOFFICE_DIRECTORY_URL` | no | Reserved for the org assertion hook. Setting it does not enable enforcement in this version |
| `WEBHOOK_FALLBACK_SECRET` | for sender-created envelopes with a webhookUrl | unchanged from v0 |
| `MONGODB_URI`, `JWT_SECRET` | yes | unchanged from v0 |

## Testing

`npm run test:unit` covers the pure logic (secrets, disclosures, policy,
webhook signing, signing turn order). `npm run test:db` covers the database
contracts against **mongodb-memory-server only**: `tests/db/harness.mjs` aborts
if `MONGODB_URI` is set, if the Mongo host is not loopback, or if the database
is not named `test`. No test in this repository may touch a live redSign
database, and the harness is the guard that enforces it rather than a
convention that hopes for it.
