import type { Db } from "mongodb";
import { getDb } from "./db";
import { isValidSigningToken, type TurnSigner } from "./signing";

// Shared lookup for the public /api/sign/[token]/* routes: the 48-hex token
// IS the credential — resolve it to (envelope, signer) or nothing.

export type SignerDoc = TurnSigner & {
  token?: string;
  values?: Record<string, string>;
  viewedAt?: Date | null;
};

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
