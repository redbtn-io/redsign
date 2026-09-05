import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authenticate, envelopeScopeFilter, requestedOrgId } from "@/lib/apiauth";
import { mintToken, sha256Hex, storePdf, validateFields, validateSigners } from "@/lib/envelopes";
import { publicBase } from "@/lib/http";
import {
  defaultExpiryDays,
  expiresInDaysToDate,
  hashAccessCode,
  parseHostAllowlist,
  resolveEnvelopeOrgId,
  resolveExpiresAt,
  webhookUrlError,
} from "@/lib/policy";
import { ENVELOPE_LIST_PROJECTION } from "@/lib/queries";
import { emitEnvelopeEvent } from "@/lib/webhooks";

const MAX_PDF = 20 * 1024 * 1024;

export async function GET(req: NextRequest) {
  try {
    const who = await authenticate(req);
    if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const q = req.nextUrl.searchParams;
    const filter: Record<string, unknown> = {};
    if (q.get("status")) filter.status = q.get("status");
    if (who.kind === "consumer") filter.createdBy = `consumer:${who.name}`;
    // Tenant scope. createdBy alone is not a boundary for a platform consumer:
    // one credential covers many orgs, so it has to name the one it is asking
    // for (?orgId=) and gets only that org's envelopes back.
    const scope = envelopeScopeFilter(who, requestedOrgId(req));
    if (scope.error) {
      return NextResponse.json({ error: scope.error.error }, { status: scope.error.status });
    }
    Object.assign(filter, scope.filter);
    const db = await getDb();
    const envelopes = await db
      .collection("envelopes")
      .find(filter, { projection: ENVELOPE_LIST_PROJECTION })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return NextResponse.json({
      envelopes: envelopes.map((e) => ({ ...e, _id: String(e._id) })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// Create + send an envelope. multipart/form-data:
//   document: PDF file
//   payload:  JSON string { signers, fields, metadata?, webhookUrl? }
// Returns { envelopeId, signers: [{ idx, signingUrl }] }.
export async function POST(req: NextRequest) {
  try {
    const who = await authenticate(req);
    if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const form = await req.formData();
    const file = form.get("document");
    if (!(file instanceof File)) return NextResponse.json({ error: "document file required" }, { status: 400 });
    if (file.type !== "application/pdf") return NextResponse.json({ error: "PDF only (v0)" }, { status: 400 });
    if (file.size > MAX_PDF) return NextResponse.json({ error: "20MB max" }, { status: 400 });

    let payload: {
      signers?: unknown;
      fields?: unknown;
      metadata?: unknown;
      webhookUrl?: unknown;
      expiresAt?: unknown;
      expiresInDays?: unknown;
    };
    try {
      payload = JSON.parse(String(form.get("payload") ?? "{}"));
    } catch {
      return NextResponse.json({ error: "payload must be JSON" }, { status: 400 });
    }
    let signers, fields;
    try {
      signers = validateSigners(payload.signers);
      fields = validateFields(payload.fields, signers.length);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    const metadata =
      payload.metadata && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : {};

    // Tenant attribution, decided in one place (lib/policy.resolveEnvelopeOrgId):
    // a platform consumer (redOffice) is multi-tenant on one credential and
    // must assert metadata.orgId; a consumer pinned with --org-id is
    // authoritative and its row wins over the body, so it cannot write an
    // envelope attributed to somebody else's org; every accepted value is
    // shape-checked before it is stored. See lib/policy.ts for the directory
    // validation hook this leaves open.
    const org = resolveEnvelopeOrgId(who, metadata);
    if (org.error) return NextResponse.json({ error: org.error }, { status: 400 });

    const webhookUrl = payload.webhookUrl ? String(payload.webhookUrl).slice(0, 500) : null;
    if (webhookUrl) {
      const err = webhookUrlError(
        webhookUrl,
        parseHostAllowlist(process.env.REDSIGN_WEBHOOK_HOST_ALLOWLIST)
      );
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
      return NextResponse.json({ error: "not a PDF" }, { status: 400 });
    }

    const now = new Date();

    // Expiry applies to NEW envelopes only. Envelopes stored before v0.2 carry
    // no expiresAt and lib/policy.isExpired treats a missing value as "never",
    // so links already in people's inboxes keep working.
    let expiresAt: Date | null;
    try {
      const fromDays = expiresInDaysToDate(payload.expiresInDays, now);
      expiresAt =
        fromDays !== undefined
          ? fromDays
          : resolveExpiresAt(
              payload.expiresAt,
              now,
              defaultExpiryDays(process.env.REDSIGN_DEFAULT_EXPIRY_DAYS)
            );
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    const fileId = await storePdf(buf, file.name || "document.pdf", {
      kind: "original", uploadedBy: who.kind === "sender" ? who.email : `consumer:${who.name}`,
    });
    const db = await getDb();
    const doc = {
      status: "sent" as const,
      documentFileId: fileId,
      documentName: file.name || "document.pdf",
      // Digest of the exact uploaded bytes, recorded at send time so the
      // certificate and the audit trail do not have to re-read GridFS to prove
      // what was sent.
      documentSha256: sha256Hex(buf),
      executedFileId: null as string | null,
      executedSha256: null as string | null,
      signers: signers.map((s, idx) => {
        const token = mintToken();
        const { accessCode, ...rest } = s;
        return {
          idx,
          ...rest,
          token,
          // The plaintext code is never stored: it is HMACed with this
          // signer's own token, so the digest is worthless without the link.
          accessCodeHash: accessCode ? hashAccessCode(token, accessCode) : null,
          status: "pending" as const,
          viewedAt: null as Date | null,
          signedAt: null as Date | null,
          consentAt: null as Date | null,
          consent: null as Record<string, unknown> | null,
          ip: null as string | null,
          ipChain: null as string | null,
          userAgent: null as string | null,
        };
      }),
      fields,
      metadata,
      orgId: org.orgId,
      webhookUrl,
      expiresAt,
      createdBy: who.kind === "sender" ? who.email : `consumer:${who.name}`,
      createdAt: now,
      sentAt: now,
      completedAt: null as Date | null,
    };
    const r = await db.collection("envelopes").insertOne(doc);
    // Envelopes are created straight into `sent` (v0 has no draft step):
    // creation IS the sent transition. Event append is awaited (durable before
    // the response); the delivery attempt itself is fire-and-forget inside.
    await emitEnvelopeEvent({ _id: r.insertedId, ...doc }, "sent", { at: now });
    const base = publicBase(req.headers);
    return NextResponse.json(
      {
        envelopeId: String(r.insertedId),
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        documentSha256: doc.documentSha256,
        signers: doc.signers.map((s) => ({
          idx: s.idx,
          signingUrl: `${base}/sign/${s.token}`,
          accessCodeRequired: Boolean(s.accessCodeHash),
        })),
      },
      { status: 201 }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
