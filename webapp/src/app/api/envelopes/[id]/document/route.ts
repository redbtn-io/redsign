import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { Readable } from "node:stream";
import { getDb } from "@/lib/db";
import { authenticate } from "@/lib/apiauth";
import { readPdf } from "@/lib/envelopes";

// Serves the executed PDF once completed, else the original.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const who = await authenticate(req);
    if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const db = await getDb();
    const e = await db.collection("envelopes").findOne({ _id: new ObjectId(id) });
    if (!e) return new NextResponse("Not found", { status: 404 });
    if (who.kind === "consumer" && e.createdBy !== `consumer:${who.name}`) {
      return new NextResponse("Not found", { status: 404 });
    }
    const fileId = e.executedFileId ?? e.documentFileId;
    const pdf = await readPdf(String(fileId));
    if (!pdf) return new NextResponse("File missing", { status: 404 });
    return new NextResponse(Readable.toWeb(pdf.stream as Readable) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${encodeURIComponent(e.documentName ?? "document")}${e.executedFileId ? "-executed" : ""}.pdf"`,
      },
    });
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
