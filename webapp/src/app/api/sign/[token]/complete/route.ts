import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { lookupEnvelopeByToken } from "@/lib/signaccess";
import { readPdfBuffer, storePdf } from "@/lib/envelopes";
import { buildExecutedPdf, type FlattenSigner } from "@/lib/flatten";
import { firstHeaderValue } from "@/lib/http";
import { emitEnvelopeEvent } from "@/lib/webhooks";
import {
  MAX_TOTAL_VALUES_BYTES,
  fieldValueError,
  missingRequiredKeys,
  signerFieldEntries,
  signingTurn,
  type SignField,
} from "@/lib/signing";

// Records a signer's completion. Body: { consent: true, values: { [fieldKey]:
// dataUrl-or-text } } where fieldKey is the field's absolute index in
// envelope.fields (as served by GET /api/sign/[token]).
//
// Signature images are stored as PNG data URLs (<=1MB each, <=10MB per
// request) on the signer inside the envelope document — well under Mongo's
// 16MB doc cap for the 1-10 signer envelopes v0 allows; GridFS stays
// reserved for the PDFs themselves.
//
// When the last signer completes, the envelope flips to `completed`
// atomically (single winner on `sent` -> `completed`), the original is
// flattened via pdf-lib with a certificate page appended, and the executed
// PDF lands in GridFS {kind:'executed'} + envelope.executedFileId.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const hit = await lookupEnvelopeByToken(token);
    if (!hit) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { db, envelope, signer } = hit;
    if (envelope.status === "voided") {
      return NextResponse.json({ error: "voided" }, { status: 404 });
    }

    const { canSign, waitingOn } = signingTurn(envelope.status, envelope.signers, signer.idx);
    if (!canSign) {
      const error =
        signer.status === "signed"
          ? "already signed"
          : envelope.status !== "sent"
            ? `envelope is ${envelope.status}`
            : `waiting on ${waitingOn ?? "an earlier signer"}`;
      return NextResponse.json({ error, waitingOn }, { status: 409 });
    }

    let body: { consent?: unknown; values?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
    }
    if (body.consent !== true) {
      return NextResponse.json({ error: "consent is required" }, { status: 400 });
    }
    const rawValues =
      body.values && typeof body.values === "object" ? (body.values as Record<string, unknown>) : {};

    // Accept only THIS signer's field keys; validate each provided value.
    const fields = (envelope.fields ?? []) as SignField[];
    const entries = signerFieldEntries(fields, signer.idx);
    const values: Record<string, string> = {};
    let totalBytes = 0;
    for (const { key, field } of entries) {
      const raw = rawValues[key];
      if (raw == null || raw === "") continue;
      if (typeof raw !== "string") {
        return NextResponse.json({ error: `field ${key}: value must be a string` }, { status: 400 });
      }
      const err = fieldValueError(field.type, raw);
      if (err) return NextResponse.json({ error: `field ${key}: ${err}` }, { status: 400 });
      totalBytes += raw.length;
      if (totalBytes > MAX_TOTAL_VALUES_BYTES) {
        return NextResponse.json({ error: "values too large (10MB max)" }, { status: 400 });
      }
      values[key] = raw;
    }
    const missing = missingRequiredKeys(fields, signer.idx, values);
    if (missing.length) {
      return NextResponse.json(
        { error: "required fields missing", fields: missing },
        { status: 400 }
      );
    }

    const now = new Date();
    const ip = firstHeaderValue(req.headers.get("x-forwarded-for"));
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300) || null;
    const envelopeId = new ObjectId(String(envelope._id));

    // Atomic: only flips this signer if they are still pending on a sent
    // envelope — a concurrent double-submit loses here and 409s.
    const r = await db.collection("envelopes").updateOne(
      {
        _id: envelopeId,
        status: "sent",
        signers: { $elemMatch: { idx: signer.idx, status: "pending" } },
      },
      {
        $set: {
          "signers.$.status": "signed",
          "signers.$.signedAt": now,
          "signers.$.consentAt": now,
          "signers.$.ip": ip,
          "signers.$.userAgent": userAgent,
          "signers.$.values": values,
        },
      }
    );
    if (!r.matchedCount) {
      return NextResponse.json({ error: "already signed" }, { status: 409 });
    }
    await emitEnvelopeEvent(envelope, "signed", { signerIdx: signer.idx, at: now });

    // Last one out flattens: claim `sent` -> `completed` atomically so exactly
    // one request builds the executed PDF.
    const fresh = await db.collection("envelopes").findOne({ _id: envelopeId });
    let completed = fresh?.status === "completed";
    const allSigned =
      Array.isArray(fresh?.signers) &&
      fresh.signers.every((s: { status: string }) => s.status === "signed");
    if (fresh && allSigned && !completed) {
      const completedAt = new Date();
      const claim = await db
        .collection("envelopes")
        .updateOne({ _id: envelopeId, status: "sent" }, { $set: { status: "completed", completedAt } });
      if (claim.matchedCount) {
        completed = true;
        try {
          const original = await readPdfBuffer(String(fresh.documentFileId));
          if (!original) throw new Error("original PDF missing from GridFS");
          const executed = await buildExecutedPdf({
            original,
            envelopeId: String(envelopeId),
            documentName: String(fresh.documentName ?? "document"),
            fields,
            signers: fresh.signers as FlattenSigner[],
            completedAt,
          });
          const executedFileId = await storePdf(
            Buffer.from(executed),
            `${String(fresh.documentName ?? "document").replace(/\.pdf$/i, "")}-executed.pdf`,
            { kind: "executed", envelopeId: String(envelopeId) }
          );
          await db
            .collection("envelopes")
            .updateOne({ _id: envelopeId }, { $set: { executedFileId } });
          // Only the claim winner emits `completed`, and only after the
          // executed PDF exists — a consumer reacting to the webhook can
          // fetch /document and get the executed copy immediately.
          await emitEnvelopeEvent(envelope, "completed", { at: completedAt });
        } catch (e) {
          // Roll the claim back so the completion isn't half-recorded.
          await db
            .collection("envelopes")
            .updateOne(
              { _id: envelopeId, status: "completed" },
              { $set: { status: "sent", completedAt: null } }
            );
          throw e;
        }
      } else {
        completed = true; // another request won the claim
      }
    }

    return NextResponse.json({ ok: true, signer: { idx: signer.idx, status: "signed" }, completed });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
