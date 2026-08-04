import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticate } from "@/lib/apiauth";
import { emitEnvelopeEvent } from "@/lib/webhooks";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const who = await authenticate(req);
    if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const db = await getDb();
    const filter: Record<string, unknown> = {
      _id: new ObjectId(id),
      status: { $in: ["draft", "sent"] },
    };
    if (who.kind === "consumer") filter.createdBy = `consumer:${who.name}`;
    const voidedAt = new Date();
    // findOneAndUpdate (not updateOne): the voided doc is needed for the
    // webhook context (webhookUrl / metadata / createdBy).
    const voided = await db
      .collection("envelopes")
      .findOneAndUpdate(filter, { $set: { status: "voided", voidedAt } }, { returnDocument: "after" });
    if (!voided) {
      return NextResponse.json({ error: "not found or not voidable" }, { status: 409 });
    }
    await emitEnvelopeEvent(voided, "voided", { at: voidedAt });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
