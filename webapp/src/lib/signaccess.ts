import type { Db } from "mongodb";
import { getDb } from "./db";
import { isValidSigningToken, type TurnSigner } from "./signing";

// tokenBlock lives in lib/policy.ts (which imports nothing but node builtins)
// so the unit tests can reach it; re-exported here because the sign routes
// think of it as part of token access.
export { tokenBlock, type TokenBlock } from "./policy";

// Shared lookup for the public /api/sign/[token]/* routes: the 48-hex token
// IS the credential — resolve it to (envelope, signer) or nothing.

export type SignerDoc = TurnSigner & {
  token?: string;
  values?: Record<string, string>;
  viewedAt?: Date | null;
  // v0.2
  accessCodeHash?: string | null;
  consent?: Record<string, unknown> | null;
  consentAt?: Date | null;
  ip?: string | null;
  ipChain?: string | null;
  userAgent?: string | null;
};

// Where a signer presents an access code. The header is what the signing page
// sends; the query parameter exists because <embed src> and a PDF download
// cannot carry a custom header.
export const ACCESS_CODE_HEADER = "x-redsign-access-code";

export function presentedAccessCode(req: {
  headers: { get(name: string): string | null };
  nextUrl?: { searchParams: URLSearchParams };
}): string | null {
  return req.headers.get(ACCESS_CODE_HEADER) ?? req.nextUrl?.searchParams.get("code") ?? null;
}

export type TokenHit = {
  db: Db;
  // Envelope document as stored (see /api/envelopes POST).
  envelope: {
    _id: unknown;
    status: string;
    documentFileId: string;
    documentName: string;
    executedFileId: string | null;
    signers: SignerDoc[];
    fields: unknown[];
    expiresAt?: Date | null;
    metadata?: unknown;
  } & Record<string, unknown>;
  signer: SignerDoc;
};

export async function lookupEnvelopeByToken(token: string): Promise<TokenHit | null> {
  if (!isValidSigningToken(token)) return null;
  const db = await getDb();
  const envelope = await db.collection("envelopes").findOne({ "signers.token": token });
  if (!envelope) return null;
  const signer = (envelope.signers as SignerDoc[]).find((s) => s.token === token);
  if (!signer) return null;
  return { db, envelope: envelope as unknown as TokenHit["envelope"], signer };
}
