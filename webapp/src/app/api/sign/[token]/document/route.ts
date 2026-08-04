import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import { lookupEnvelopeByToken } from "@/lib/signaccess";
import { readPdf } from "@/lib/envelopes";

// Streams the ORIGINAL PDF (inline) to the signer. Never the executed copy:
// the public page only confirms completion — the sender distributes the
// signed document.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const hit = await lookupEnvelopeByToken(token);
    if (!hit || hit.envelope.status === "voided") {
      return new NextResponse("Not found", { status: 404 });
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
