import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticate, envelopeDenial, requestedOrgId } from "@/lib/apiauth";
import { ENVELOPE_DETAIL_PROJECTION } from "@/lib/queries";

// v0.2: signers.values (the collected PNG signatures) is projected out here and
// on the list, the same way tokens always were. A consumer that legitimately
// needs the images asks GET /api/envelopes/:id/values, which is owner-only and
// audited by being a distinct call. accessCodeHash never leaves the database.

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
    const e = await db
      .collection("envelopes")
      .findOne({ _id: new ObjectId(id) }, { projection: ENVELOPE_DETAIL_PROJECTION });
    if (!e) return NextResponse.json({ error: "not found" }, { status: 404 });
    const denied = envelopeDenial(who, e, requestedOrgId(req));
    if (denied) {
      return NextResponse.json({ error: denied.error }, { status: denied.status });
    }
    return NextResponse.json({ envelope: { ...e, _id: String(e._id) } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
