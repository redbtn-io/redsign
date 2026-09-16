import { jwtVerify } from "jose";

// The ecosystem session: accounts.redbtn.io is the sole issuer of the
// domain-wide `red_session` cookie (HS256, shared JWT_SECRET). redSign only
// VERIFIES it — it never mints, refreshes or deletes it.

export const SESSION_COOKIE = "red_session";

export interface RedSession {
  email: string;
  userId?: string;
  sid?: string;
}

function sharedSecret(): string {
  return (process.env.JWT_SECRET ?? "").replace(/^"|"$/g, "");
}

/** Signature-valid session payload, or null. Fails closed with no secret. */
export async function readRedSession(
  token: string | null | undefined,
): Promise<RedSession | null> {
  const secret = sharedSecret();
  if (!secret || !token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
    });
    const email = String(payload.email ?? "").toLowerCase();
    if (!email) return null;
    return {
      email,
      userId: payload.userId ? String(payload.userId) : undefined,
      sid: payload.sid ? String(payload.sid) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Sender access rule, UNCHANGED from the pre-landing gate: a signature-valid
 * shared session whose email is @redbtn.io. The landing page moves the
 * sign-in button from app.redbtn.io to accounts.redbtn.io; who gets in does
 * not move a hair. Do not widen this.
 */
export function isSender(session: RedSession | null): boolean {
  return Boolean(session && session.email.endsWith("@redbtn.io"));
}

/** CI/e2e only — never set in prod. */
export function authBypass(): boolean {
  return process.env.AUTH_BYPASS === "1";
}
