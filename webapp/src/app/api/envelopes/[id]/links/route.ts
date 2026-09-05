import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticate, ownsEnvelope } from "@/lib/apiauth";
import { publicBase } from "@/lib/http";

// Signing links for an envelope's signers — the one read that intentionally
// returns tokens (as full URLs). Senders use it to re-copy a pending signer's
// link from the dashboard; consumers own their envelopes and may re-fetch the
// links they were handed at creation (e.g. after losing the create response).
// Every other envelope read keeps projecting tokens out.
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
    if (!e) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!ownsEnvelope(who, e)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const base = publicBase(req.headers);
    return NextResponse.json(
      {
        expiresAt: e.expiresAt ?? null,
        signers: (
          e.signers as Array<{
            idx: number;
            name: string;
            status: string;
            token: string;
            accessCodeHash?: string | null;
          }>
        ).map((s) => ({
          idx: s.idx,
          name: s.name,
          status: s.status,
          signingUrl: `${base}/sign/${s.token}`,
          // The code itself is never recoverable (it is HMACed with the
          // token); the sender only learns whether one is set.
          accessCodeRequired: Boolean(s.accessCodeHash),
        })),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
