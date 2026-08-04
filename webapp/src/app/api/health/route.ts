import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return NextResponse.json({ ok: true, db: "up" });
  } catch (e) {
    return NextResponse.json(
      { ok: false, db: "down", error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }
}
