import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticate, envelopeDenial, requestedOrgId } from "@/lib/apiauth";
import { readPdfBuffer, sha256Hex } from "@/lib/envelopes";

// The signature certificate as JSON, complete and unpaginated (v0.2).
//
// GET /:id/events is the dashboard's timeline: newest first, capped at 100, so
// a long-running envelope silently loses its oldest rows. That cap is fine for
// a UI and useless for a record. This route is the record: every event in
// chronological order with no limit, every signer's consent and disclosure
// version, both document digests, and the delivery outcome of every webhook.
// Consumers archive this beside the executed PDF.
//
// It never contains signer tokens, access-code digests or the collected
// signature PNGs. The images live behind /:id/values on purpose.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const who = await authenticate(req);
    if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    if (!ObjectId.isValid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const db = await getDb();
    const e = await db.collection("envelopes").findOne({ _id: new ObjectId(id) });
    if (!e) return NextResponse.json({ error: "not found" }, { status: 404 });
    const denied = envelopeDenial(who, e, requestedOrgId(req));
    if (denied) {
      return NextResponse.json({ error: denied.error }, { status: denied.status });
    }

    // Envelopes created before v0.2 have no stored digests. Recompute rather
    // than report null: an audit record that omits the hash of the document it
    // is auditing is not worth archiving.
    let documentSha256 = typeof e.documentSha256 === "string" ? e.documentSha256 : null;
    if (!documentSha256 && e.documentFileId) {
      const buf = await readPdfBuffer(String(e.documentFileId));
      if (buf) documentSha256 = sha256Hex(buf);
    }
    let executedSha256 = typeof e.executedSha256 === "string" ? e.executedSha256 : null;
    if (!executedSha256 && e.executedFileId) {
      const buf = await readPdfBuffer(String(e.executedFileId));
      if (buf) executedSha256 = sha256Hex(buf);
    }

    const events = await db
      .collection("envelope_events")
      .find({ envelopeId: id }, { projection: { _id: 0, envelopeId: 0 } })
      .sort({ at: 1 })
      .toArray();

    const deliveries = await db
      .collection("webhook_deliveries")
      .find(
        { envelopeId: id },
        { projection: { _id: 0, body: 0, sig: 0 } } // the signed body is not audit material, the outcome is
      )
      .sort({ createdAt: 1 })
      .toArray();

    const signers = (e.signers ?? []) as Array<Record<string, unknown>>;

    return NextResponse.json(
      {
        envelope: {
          id: String(e._id),
          status: e.status,
          documentName: e.documentName,
          documentSha256,
          executedSha256,
          metadata: e.metadata ?? {},
          orgId: e.orgId ?? null,
          createdBy: e.createdBy ?? null,
          createdAt: e.createdAt ?? null,
          sentAt: e.sentAt ?? null,
          completedAt: e.completedAt ?? null,
          voidedAt: e.voidedAt ?? null,
          expiresAt: e.expiresAt ?? null,
          webhookUrl: e.webhookUrl ?? null,
        },
        signers: signers.map((s) => ({
          idx: s.idx,
          name: s.name,
          email: s.email ?? null,
          order: s.order ?? null,
          status: s.status,
          accessCodeRequired: Boolean(s.accessCodeHash),
          viewedAt: s.viewedAt ?? null,
          consentAt: s.consentAt ?? null,
          consent: s.consent ?? null,
          signedAt: s.signedAt ?? null,
          ip: s.ip ?? null,
          ipChain: s.ipChain ?? null,
          userAgent: s.userAgent ?? null,
        })),
        events,
        webhookDeliveries: deliveries,
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
