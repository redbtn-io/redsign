import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticate } from "@/lib/apiauth";

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
      .findOne({ _id: new ObjectId(id) }, { projection: { "signers.token": 0 } });
    if (!e) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (who.kind === "consumer" && e.createdBy !== `consumer:${who.name}`) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ envelope: { ...e, _id: String(e._id) } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
