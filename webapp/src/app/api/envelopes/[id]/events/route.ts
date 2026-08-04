import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticate } from "@/lib/apiauth";

// Lifecycle audit trail (envelope_events), newest first — the dashboard's
// timeline. Same ownership rule as the envelope read: consumers only see
// their own envelopes.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const who = await authenticate(req);
    if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const db = await getDb();
    const e = await db
      .collection("envelopes")
      .findOne({ _id: new ObjectId(id) }, { projection: { createdBy: 1 } });
    if (!e) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (who.kind === "consumer" && e.createdBy !== `consumer:${who.name}`) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const events = await db
      .collection("envelope_events")
      .find({ envelopeId: id }, { projection: { _id: 0, envelopeId: 0 } })
      .sort({ at: -1 })
      .limit(100)
      .toArray();
    return NextResponse.json({ events }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
