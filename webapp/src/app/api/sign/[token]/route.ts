import { NextRequest, NextResponse } from "next/server";
import { lookupEnvelopeByToken } from "@/lib/signaccess";
import { signerFieldEntries, signingTurn, type SignField } from "@/lib/signing";

// Public signer state (Phase 3). Token-guarded, no auth: middleware exempts
// /api/sign/*, and the 48-hex token IS the credential. Unknown and voided
// links both 404 (the body's `error` distinguishes them so the page can say
// "voided" without the endpoint acknowledging live envelopes to guessers).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const hit = await lookupEnvelopeByToken(token);
    if (!hit) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { envelope, signer } = hit;
    if (envelope.status === "voided") {
      return NextResponse.json({ error: "voided" }, { status: 404 });
    }
    const { canSign, waitingOn } = signingTurn(
      String(envelope.status),
      envelope.signers,
      signer.idx
    );
    return NextResponse.json(
      {
        envelope: { documentName: envelope.documentName, status: envelope.status },
        signer: { idx: signer.idx, name: signer.name, status: signer.status },
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
