import { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { verifyConsumerKey } from "./envelopes";

// Envelope API auth: EITHER a sender session (red_session cookie, @redbtn.io)
// OR a machine consumer key (x-redsign-key, verified against the hashed
// store). The middleware lets /api/envelopes* through when the header is
// present; this helper is the actual gate — every envelope route calls it.
export type ApiIdentity =
  | { kind: "sender"; email: string }
  | { kind: "consumer"; name: string; platform: boolean; orgId: string | null };

export async function authenticate(req: NextRequest): Promise<ApiIdentity | null> {
  const key = req.headers.get("x-redsign-key");
  if (key) {
    const consumer = await verifyConsumerKey(key);
    return consumer ? { kind: "consumer", ...consumer } : null;
  }
  const secret = (process.env.JWT_SECRET ?? "").replace(/^"|"$/g, "");
  const token = req.cookies.get("red_session")?.value;
  if (secret && token) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
      const email = String(payload.email ?? "").toLowerCase();
      if (email.endsWith("@redbtn.io")) return { kind: "sender", email };
    } catch { /* fall through */ }
  }
  return null;
}

// Ownership rule, in one place: a consumer only ever sees the envelopes it
// created; @redbtn.io senders see everything (there is exactly one sender
// tenant in v0.2 — tenant senders are not part of this version).
export function ownsEnvelope(who: ApiIdentity, envelope: Record<string, unknown>): boolean {
  if (who.kind === "sender") return true;
  return envelope.createdBy === `consumer:${who.name}`;
}
