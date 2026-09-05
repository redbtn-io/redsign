import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { lookupEnvelopeByToken, presentedAccessCode, tokenBlock } from "@/lib/signaccess";
import { accessCodeMatches } from "@/lib/policy";
import { clientIp } from "@/lib/http";
import { consentClaimFilter } from "@/lib/queries";
import {
  DISCLOSURE_VERSION,
  disclosureFor,
  disclosureKindFor,
  disclosureSha256,
} from "@/lib/disclosures";
import { emitEnvelopeEvent } from "@/lib/webhooks";

// POST /api/sign/:token/consent — the ESIGN consent record (v0.2).
//
// v0 folded consent into the completion call as a bare `consent: true`
// boolean. That is enough to gate the button and not enough to be evidence:
// nothing recorded WHICH disclosure the signer was shown, and the only
// timestamp was the one taken when they finished signing, which is not when
// they agreed. This route records consent at the moment it is given, from the
// server's own clock, with the disclosure version and a digest of the exact
// text served to that signer.
//
// It is idempotent by design: a second consent for a signer who already
// consented returns the first record rather than overwriting it. The earliest
// consent is the one that matters, and letting a later call move the timestamp
// would make the record worth less than not having it.
//
// Body: { consent: true, disclosureVersion?: string }. A disclosureVersion
// that does not match what the server would serve today is refused (409) so a
// stale page cannot record agreement to text the signer never saw.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const hit = await lookupEnvelopeByToken(token);
    if (!hit) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { db, envelope, signer } = hit;
    const blocked = tokenBlock(envelope);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 404 });
    if (!accessCodeMatches(signer, presentedAccessCode(req))) {
      return NextResponse.json({ requiresAccessCode: true }, { status: 401 });
    }

    let body: { consent?: unknown; disclosureVersion?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
    }
    if (body.consent !== true) {
      return NextResponse.json({ error: "consent is required" }, { status: 400 });
    }
    if (body.disclosureVersion != null && String(body.disclosureVersion) !== DISCLOSURE_VERSION) {
      return NextResponse.json(
        {
          error: "disclosure has changed since this page loaded",
          disclosureVersion: DISCLOSURE_VERSION,
        },
        { status: 409 }
      );
    }

    if (signer.consent && signer.consentAt) {
      return NextResponse.json({ ok: true, alreadyConsented: true, consent: signer.consent });
    }

    const disclosure = disclosureFor(disclosureKindFor(envelope.metadata));
    const { ip, chain, source } = clientIp(req.headers);
    // Server clock, not the client's: a timestamp the signer's device supplied
    // proves nothing.
    const at = new Date();
    const record = {
      at,
      disclosureVersion: disclosure.version,
      disclosureKind: disclosure.kind,
      disclosureSha256: disclosureSha256(disclosure),
      ip,
      ipChain: chain,
      ipSource: source,
      userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300) || null,
    };

    // Compare-and-set on "no consent yet": two racing submissions record one.
    const r = await db
      .collection("envelopes")
      .updateOne(consentClaimFilter(new ObjectId(String(envelope._id)), signer.idx), {
        $set: { "signers.$.consentAt": at, "signers.$.consent": record },
      });
    if (!r.modifiedCount) {
      const fresh = await db
        .collection("envelopes")
        .findOne({ _id: new ObjectId(String(envelope._id)) }, { projection: { signers: 1 } });
      const s = (fresh?.signers as Array<{ idx: number; consent?: unknown }> | undefined)?.find(
        (x) => x.idx === signer.idx
      );
      return NextResponse.json({ ok: true, alreadyConsented: true, consent: s?.consent ?? null });
    }

    // Audit-only event: recorded on the envelope timeline, never delivered as
    // a webhook (see lib/webhooksig.ts AUDIT_ONLY_EVENTS).
    await emitEnvelopeEvent(envelope, "consent", {
      signerIdx: signer.idx,
      at,
      meta: {
        disclosureVersion: record.disclosureVersion,
        disclosureKind: record.disclosureKind,
        disclosureSha256: record.disclosureSha256,
        ip: record.ip,
        ipChain: record.ipChain,
      },
    });

    return NextResponse.json(
      { ok: true, consent: record },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
