import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import { lookupEnvelopeByToken, presentedAccessCode, tokenBlock } from "@/lib/signaccess";
import { readPdf } from "@/lib/envelopes";
import { accessCodeMatches } from "@/lib/policy";

// Streams the ORIGINAL PDF (inline) to the signer. Never the executed copy:
// the public page only confirms completion — the sender distributes the
// signed document.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const hit = await lookupEnvelopeByToken(token);
    if (!hit || tokenBlock(hit.envelope)) {
      return new NextResponse("Not found", { status: 404 });
    }
    // react-pdf fetches this URL directly, so the code rides as ?code= here
    // rather than as the header the JSON calls use.
    if (!accessCodeMatches(hit.signer, presentedAccessCode(req))) {
      return new NextResponse("Access code required", { status: 401 });
    }
    const pdf = await readPdf(String(hit.envelope.documentFileId));
    if (!pdf) return new NextResponse("File missing", { status: 404 });
    return new NextResponse(Readable.toWeb(pdf.stream as Readable) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${encodeURIComponent(hit.envelope.documentName ?? "document")}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
