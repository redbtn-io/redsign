import crypto from "node:crypto";

// Pure webhook logic (Phase 4): payload shape, HMAC signing/verification and
// the retry/backoff state machine. Dependency-free on purpose (node builtins
// only) so unit tests run under `node --test` with type stripping — the same
// reason lib/signing.ts carries no app imports.

export const SIGNATURE_HEADER = "X-RedSign-Signature";

export const WEBHOOK_EVENTS = [
  "sent",
  "viewed",
  "signed",
  "completed",
  "declined", // reserved: no decline flow ships in v0, the name is allocated
  "voided",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// Contract payload: { event, envelopeId, signerIdx?, at, metadata }.
// Serialized ONCE at enqueue time — the stored string is what gets signed and
// what gets POSTed, byte for byte, on every attempt. Signing a re-serialization
// would risk key-order drift breaking the consumer's verification.
export function buildWebhookBody(input: {
  event: WebhookEvent;
  envelopeId: string;
  signerIdx?: number | null;
  at: Date;
  metadata: unknown;
}): string {
  return JSON.stringify({
    event: input.event,
    envelopeId: input.envelopeId,
    ...(input.signerIdx == null ? {} : { signerIdx: input.signerIdx }),
    at: input.at.toISOString(),
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  });
}

// X-RedSign-Signature: sha256=<hmac-sha256-hex of the raw request body>.
export function signBody(secret: string, rawBody: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

// Constant-time verification for consumers (and our own tests).
export function verifySignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(secret, rawBody));
  const got = Buffer.from(String(header));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// --- delivery retry state machine ---
//
// No queue infra: deliveries live in the `webhook_deliveries` collection and a
// 60s in-process sweep (src/instrumentation.ts) retries the due ones. Backoff
// 30s → 2m → 10m (then 10m again), 5 attempts total, then status `failed`.

export const MAX_DELIVERY_ATTEMPTS = 5;
export const RETRY_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

// Delay before attempt N+1, given N attempts have already been made (N >= 1).
export function retryDelayMs(attemptsMade: number): number {
  const i = Math.min(Math.max(attemptsMade, 1) - 1, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i];
}

export type DeliveryStatus = "pending" | "inflight" | "delivered" | "failed";

export type DeliveryTransition = {
  status: Extract<DeliveryStatus, "pending" | "delivered" | "failed">;
  attempts: number;
  nextAttemptAt: Date | null;
};

// Outcome of one delivery attempt: success ends it, failure schedules the next
// try until the attempt cap turns the row `failed` for good.
export function deliveryTransition(attemptsBefore: number, ok: boolean, now: Date): DeliveryTransition {
  const attempts = attemptsBefore + 1;
  if (ok) return { status: "delivered", attempts, nextAttemptAt: null };
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return { status: "failed", attempts, nextAttemptAt: null };
  return { status: "pending", attempts, nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)) };
}

// `viewed` fires once per signer: only when nothing has been recorded yet.
// The actual once-ness under concurrency is a Mongo $elemMatch { viewedAt:
// null } compare-and-set (lib/webhooks.ts); this predicate is the shared
// definition of "not yet viewed" ({ viewedAt: null } matches missing OR null).
export function shouldMarkViewed(signer: { viewedAt?: Date | string | null }): boolean {
  return signer.viewedAt == null;
}
