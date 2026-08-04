import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authenticate } from "@/lib/apiauth";
import { mintToken, storePdf, validateFields, validateSigners } from "@/lib/envelopes";
import { firstHeaderValue } from "@/lib/http";

const MAX_PDF = 20 * 1024 * 1024;

function publicBase(req: NextRequest): string {
  // Forwarded headers arrive comma-joined through the proxy chain — take the
  // first value or signing links come out as "https,http://sign...".
  const proto = firstHeaderValue(req.headers.get("x-forwarded-proto")) ?? "https";
  const host =
    firstHeaderValue(req.headers.get("x-forwarded-host")) ??
    firstHeaderValue(req.headers.get("host")) ??
    "sign.redbtn.io";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  try {
    const who = await authenticate(req);
    if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const q = req.nextUrl.searchParams;
    const filter: Record<string, unknown> = {};
    if (q.get("status")) filter.status = q.get("status");
    if (who.kind === "consumer") filter.createdBy = `consumer:${who.name}`;
    const db = await getDb();
    const envelopes = await db
      .collection("envelopes")
      .find(filter, { projection: { "signers.token": 0 } })
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

    let payload: { signers?: unknown; fields?: unknown; metadata?: unknown; webhookUrl?: unknown };
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
    const webhookUrl = payload.webhookUrl ? String(payload.webhookUrl).slice(0, 500) : null;
    if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) {
      return NextResponse.json({ error: "webhookUrl must be http(s)" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
      return NextResponse.json({ error: "not a PDF" }, { status: 400 });
    }

    const now = new Date();
    const fileId = await storePdf(buf, file.name || "document.pdf", {
      kind: "original", uploadedBy: who.kind === "sender" ? who.email : `consumer:${who.name}`,
    });
    const db = await getDb();
    const doc = {
      status: "sent" as const,
      documentFileId: fileId,
      documentName: file.name || "document.pdf",
      executedFileId: null as string | null,
      signers: signers.map((s, idx) => ({
        idx,
        ...s,
        token: mintToken(),
        status: "pending" as const,
        signedAt: null as Date | null,
        consentAt: null as Date | null,
        ip: null as string | null,
        userAgent: null as string | null,
      })),
      fields,
      metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
      webhookUrl,
      createdBy: who.kind === "sender" ? who.email : `consumer:${who.name}`,
      createdAt: now,
      sentAt: now,
      completedAt: null as Date | null,
    };
    const r = await db.collection("envelopes").insertOne(doc);
    const base = publicBase(req);
    return NextResponse.json(
      {
        envelopeId: String(r.insertedId),
        signers: doc.signers.map((s) => ({ idx: s.idx, signingUrl: `${base}/sign/${s.token}` })),
      },
      { status: 201 }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
