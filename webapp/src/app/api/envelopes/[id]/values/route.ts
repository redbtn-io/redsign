import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticate, ownsEnvelope } from "@/lib/apiauth";

// Collected field values, including the signature and initials PNGs (v0.2).
//
// Every other envelope read projects signers.values out. A signature image is
// biometric-adjacent personal data and it is the one thing in an envelope that
// is directly reusable for forgery, so it does not ride along on a list or a
// status poll. This route is the single deliberate way to it: owner-only (the
// creating consumer, or an @redbtn.io sender), never cached, and separate
// enough that "who pulled the signature images" is answerable from access logs.
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
    if (!e || !ownsEnvelope(who, e)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const signers = (e.signers ?? []) as Array<{
      idx: number;
      name: string;
      status: string;
      signedAt?: Date | null;
      values?: Record<string, string>;
    }>;
    return NextResponse.json(
      {
        envelopeId: String(e._id),
        signers: signers.map((s) => ({
          idx: s.idx,
          name: s.name,
          status: s.status,
          signedAt: s.signedAt ?? null,
          values: s.values ?? {},
        })),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
