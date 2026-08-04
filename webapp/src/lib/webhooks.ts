import type { Db, ObjectId } from "mongodb";
import { getDb } from "./db";
import {
  SIGNATURE_HEADER,
  buildWebhookBody,
  deliveryTransition,
  shouldMarkViewed,
  signBody,
  type WebhookEvent,
} from "./webhooksig";

// Lifecycle events + webhook dispatch (Phase 4).
//
// Every transition appends to `envelope_events` (the dashboard's timeline).
// When the envelope carries a webhookUrl, a signed delivery is enqueued in
// `webhook_deliveries` and attempted immediately, fire-and-forget; the 60s
// sweep in src/instrumentation.ts retries failures with backoff (30s/2m/10m,
// 5 attempts max — see lib/webhooksig.ts).
//
// Secrets: consumer-created envelopes (createdBy "consumer:<name>") sign with
// that consumer's `webhookSecret` (plaintext in the consumers row — redSign
// must be able to compute the HMAC, so unlike the service key it cannot be
// hashed at rest). Sender-created envelopes sign with the deployment-wide
// WEBHOOK_FALLBACK_SECRET env var.

const MIN_SECRET_LEN = 16;
const DELIVERY_TIMEOUT_MS = 10_000;
const CLAIM_STALE_MS = 5 * 60_000; // reclaim inflight rows this old (crashed attempt)

// The subset of an envelope document the dispatcher needs. Loose on purpose:
// callers hold envelope docs typed several different ways.
export type WebhookEnvelope = {
  _id: unknown;
  webhookUrl?: unknown;
  metadata?: unknown;
  createdBy?: unknown;
};

export type DeliveryDoc = {
  _id: ObjectId;
  envelopeId: string;
  event: WebhookEvent;
  signerIdx: number | null;
  url: string;
  body: string;
  sig: string;
  attempts: number;
  status: "pending" | "inflight" | "delivered" | "failed";
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function recordEvent(
  db: Db,
  envelopeId: string,
  event: WebhookEvent,
  opts: { signerIdx?: number | null; at?: Date; meta?: Record<string, unknown> } = {}
): Promise<Date> {
  const at = opts.at ?? new Date();
  await db.collection("envelope_events").insertOne({
    envelopeId,
    event,
    signerIdx: opts.signerIdx ?? null,
    at,
    meta: opts.meta ?? {},
  });
  return at;
}

async function resolveSecret(db: Db, createdBy: string): Promise<string | null> {
  if (createdBy.startsWith("consumer:")) {
    const row = await db.collection("consumers").findOne({ name: createdBy.slice("consumer:".length) });
    const s = row?.webhookSecret;
    return typeof s === "string" && s.length >= MIN_SECRET_LEN ? s : null;
  }
  const fallback = process.env.WEBHOOK_FALLBACK_SECRET ?? "";
  return fallback.length >= MIN_SECRET_LEN ? fallback : null;
}

// Append the audit event and, if the envelope has a webhookUrl, enqueue a
// signed delivery + kick an immediate attempt (fire-and-forget — route
// latency never waits on the consumer's endpoint). Never throws: a webhook
// hiccup must not fail the signing transition that triggered it.
export async function emitEnvelopeEvent(
  envelope: WebhookEnvelope,
  event: WebhookEvent,
  opts: { signerIdx?: number | null; at?: Date } = {}
): Promise<void> {
  try {
    const db = await getDb();
    const envelopeId = String(envelope._id);
    const at = await recordEvent(db, envelopeId, event, opts);

    const url = typeof envelope.webhookUrl === "string" && envelope.webhookUrl ? envelope.webhookUrl : null;
    if (!url) return;
    const createdBy = typeof envelope.createdBy === "string" ? envelope.createdBy : "";
    const secret = await resolveSecret(db, createdBy);
    const body = buildWebhookBody({
      event,
      envelopeId,
      signerIdx: opts.signerIdx,
      at,
      metadata: envelope.metadata,
    });
    if (!secret) {
      // Recorded (not silently dropped) but never attempted: an unsigned
      // webhook would train consumers to skip verification.
      await db.collection("webhook_deliveries").insertOne({
        envelopeId, event, signerIdx: opts.signerIdx ?? null, url, body, sig: null,
        attempts: 0, status: "failed", nextAttemptAt: null,
        lastError: "no signing secret configured", createdAt: at, updatedAt: at,
      });
      console.error(`[webhooks] no signing secret for ${createdBy || "sender"} — delivery recorded as failed`);
      return;
    }
    const sig = signBody(secret, body);
    const r = await db.collection("webhook_deliveries").insertOne({
      envelopeId, event, signerIdx: opts.signerIdx ?? null, url, body, sig,
      attempts: 0, status: "pending", nextAttemptAt: at,
      lastError: null, createdAt: at, updatedAt: at,
    });
    void attemptDelivery(db, { _id: r.insertedId }).catch((e) =>
      console.error("[webhooks] immediate attempt failed:", e)
    );
  } catch (e) {
    console.error(`[webhooks] emit ${event} failed:`, e);
  }
}

// Claim (atomic: exactly one worker wins a due row) and perform one attempt.
// Also reclaims inflight rows stuck past CLAIM_STALE_MS — a crashed process
// must not strand its claimed deliveries forever.
async function attemptDelivery(db: Db, filter: Record<string, unknown>): Promise<boolean> {
  const now = new Date();
  const row = (await db.collection("webhook_deliveries").findOneAndUpdate(
    {
      ...filter,
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        { status: "inflight", claimedAt: { $lte: new Date(now.getTime() - CLAIM_STALE_MS) } },
      ],
    },
    { $set: { status: "inflight", claimedAt: now } },
    { returnDocument: "after" }
  )) as DeliveryDoc | null;
  if (!row) return false;

  let ok = false;
  let lastError: string | null = null;
  try {
    const res = await fetch(row.url, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: row.sig },
      body: row.body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    ok = res.ok;
    if (!ok) lastError = `HTTP ${res.status}`;
  } catch (e) {
    lastError = e instanceof Error ? (e.name === "TimeoutError" ? "timeout (10s)" : e.message) : String(e);
  }

  const done = new Date();
  const t = deliveryTransition(row.attempts, ok, done);
  await db.collection("webhook_deliveries").updateOne(
    { _id: row._id },
    {
      $set: {
        status: t.status,
        attempts: t.attempts,
        nextAttemptAt: t.nextAttemptAt,
        lastError,
        updatedAt: done,
        ...(ok ? { deliveredAt: done } : {}),
      },
    }
  );
  return true;
}

// The 60s sweep: drain everything currently due, one claimed row at a time.
export async function sweepDueDeliveries(limit = 25): Promise<number> {
  const db = await getDb();
  let n = 0;
  while (n < limit && (await attemptDelivery(db, {}))) n++;
  return n;
}

// `viewed`, once per signer: compare-and-set on { viewedAt: null } means a
// double GET (or two racing ones) records exactly one view, one event, one
// webhook. Returns whether this call was the recording one.
export async function recordViewedOnce(
  envelope: WebhookEnvelope,
  signer: { idx: number; viewedAt?: Date | string | null }
): Promise<boolean> {
  try {
    if (!shouldMarkViewed(signer)) return false;
    const db = await getDb();
    const now = new Date();
    const r = await db.collection("envelopes").updateOne(
      { _id: envelope._id as ObjectId, signers: { $elemMatch: { idx: signer.idx, viewedAt: null } } },
      { $set: { "signers.$.viewedAt": now } }
    );
    if (r.modifiedCount !== 1) return false;
    await emitEnvelopeEvent(envelope, "viewed", { signerIdx: signer.idx, at: now });
    return true;
  } catch (e) {
    console.error("[webhooks] recordViewedOnce failed:", e);
    return false;
  }
}
