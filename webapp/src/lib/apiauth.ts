import { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { verifyConsumerKey } from "./envelopes";
import { envelopeAccessDenial, orgScopeFilter, type Denial } from "./policy";

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

// Access rule, in one place. A consumer only ever sees the envelopes it
// created; @redbtn.io senders see everything (there is exactly one sender
// tenant in v0.2 — tenant senders are not part of this version).
//
// Ownership alone is NOT a tenant boundary for a PLATFORM consumer, which
// holds one credential for many orgs: every envelope it created passes an
// ownership check, whichever tenant it belongs to. So there is deliberately no
// bare ownsEnvelope export any more — every route calls envelopeDenial, which
// is ownership AND org scope, and the pure rules live in lib/policy.ts where
// they can be unit tested without next/server.

// The org a caller says it is acting for, from ?orgId=. Required from platform
// consumers, optional for everyone else (it narrows a list, or asserts which
// tenant a single envelope is expected to belong to).
export function requestedOrgId(req: NextRequest): string | null {
  const raw = req.nextUrl.searchParams.get("orgId");
  const s = raw ? raw.trim() : "";
  return s ? s : null;
}

// Single gate for every single-envelope read: ownership first (404, never 403,
// so envelope ids cannot be probed), then tenant scope. Returns null when the
// read is allowed, or the status and body to answer with.
export function envelopeDenial(
  who: ApiIdentity,
  envelope: Record<string, unknown>,
  requested: string | null
): Denial | null {
  return envelopeAccessDenial(who, envelope, requested);
}

// Mongo filter fragment narrowing a list or a scoped write to one tenant.
export function envelopeScopeFilter(who: ApiIdentity, requested: string | null) {
  return orgScopeFilter(who, requested);
}

export type { Denial };
