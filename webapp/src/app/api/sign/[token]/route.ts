import { NextRequest, NextResponse } from "next/server";
import { lookupEnvelopeByToken, presentedAccessCode, tokenBlock } from "@/lib/signaccess";
import { signerFieldEntries, signingTurn, type SignField } from "@/lib/signing";
import { accessCodeMatches } from "@/lib/policy";
import { disclosureFor, disclosureKindFor } from "@/lib/disclosures";
import { recordViewedOnce } from "@/lib/webhooks";

// Public signer state (Phase 3, extended in v0.2). Token-guarded, no auth:
// middleware exempts /api/sign/*, and the 48-hex token IS the credential.
// Unknown, voided and expired links all 404 (the body's `error` distinguishes
// them so the page can explain itself without the endpoint acknowledging live
// envelopes to guessers).
//
// v0.2 adds two things: the ESIGN disclosure the signer must be shown before
// consenting, and the optional access code. When a code is configured and not
// presented, the response is deliberately thin — the signer's name so the
// right person knows they are in the right place, and nothing else. No field
// list, no document name.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const hit = await lookupEnvelopeByToken(token);
    if (!hit) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { envelope, signer } = hit;
    const blocked = tokenBlock(envelope);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 404 });

    if (!accessCodeMatches(signer, presentedAccessCode(req))) {
      return NextResponse.json(
        {
          requiresAccessCode: true,
          signer: { idx: signer.idx, name: signer.name },
        },
        { status: 401, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // First state fetch per signer = `viewed`, exactly once (atomic
    // compare-and-set on viewedAt: null → event + webhook inside). Deliberately
    // after the access-code gate: a link without its code has not been viewed
    // by the signer in any sense worth recording.
    await recordViewedOnce(envelope, signer);
    const { canSign, waitingOn } = signingTurn(
      String(envelope.status),
      envelope.signers,
      signer.idx
    );
    return NextResponse.json(
      {
        envelope: {
          documentName: envelope.documentName,
          status: envelope.status,
          expiresAt: envelope.expiresAt ?? null,
        },
        signer: {
          idx: signer.idx,
          name: signer.name,
          status: signer.status,
          consentAt: signer.consentAt ?? null,
        },
        // The exact text this signer has to be shown before consenting, and
        // the version that gets recorded with their consent.
        disclosure: disclosureFor(disclosureKindFor(envelope.metadata)),
        fields: signerFieldEntries((envelope.fields ?? []) as SignField[], signer.idx).map(
          ({ key, field }) => ({
            key,
            type: field.type,
            page: field.page,
            x: field.x,
            y: field.y,
            w: field.w,
            h: field.h,
            required: field.required !== false,
          })
        ),
        canSign,
        waitingOn,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
