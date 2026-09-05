import crypto from "node:crypto";

// Envelope-encryption helper for secrets redSign must be able to READ back
// (webhook HMAC keys), as opposed to credentials it only ever compares
// (service keys, which stay hashed). v0 stored webhook secrets in plaintext on
// the consumers row; v0.2 stores them AES-256-GCM encrypted under
// REDSIGN_SECRETS_KEY.
//
// Dependency-free on purpose (node builtins only) so the unit tests run under
// `node --test` with type stripping — same rule as lib/signing.ts.
//
// Blob format: "v1.<iv-hex>.<tag-hex>.<ciphertext-hex>". The version prefix is
// what makes rotation to a different cipher possible later without guessing.

export const SECRET_BLOB_PREFIX = "v1.";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32;

export class SecretsKeyError extends Error {}

// Accepts 64-hex or base64 (44 chars incl. padding) — 32 bytes either way.
// Anything else is a configuration mistake and throws rather than silently
// deriving a weak key.
export function parseSecretsKey(raw: string | undefined | null): Buffer {
  const value = (raw ?? "").trim().replace(/^"|"$/g, "");
  if (!value) throw new SecretsKeyError("REDSIGN_SECRETS_KEY is not set");
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) buf = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) buf = Buffer.from(value, "base64");
  if (!buf || buf.length !== KEY_BYTES) {
    throw new SecretsKeyError("REDSIGN_SECRETS_KEY must be 32 bytes (64 hex chars or base64)");
  }
  return buf;
}

export function generateSecretsKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}

export function isEncryptedBlob(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_BLOB_PREFIX);
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_BLOB_PREFIX}${iv.toString("hex")}.${tag.toString("hex")}.${ct.toString("hex")}`;
}

export function decryptSecret(key: Buffer, blob: string): string {
  if (!isEncryptedBlob(blob)) throw new SecretsKeyError("not an encrypted secret blob");
  const parts = blob.slice(SECRET_BLOB_PREFIX.length).split(".");
  if (parts.length !== 3) throw new SecretsKeyError("malformed secret blob");
  const [ivHex, tagHex, ctHex] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  // Tampering (or the wrong key) fails the GCM tag check here, loudly.
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

// Reads a consumer row's webhook secret. v0.2 rows carry `webhookSecretEnc`;
// v0 rows carry plaintext `webhookSecret`. Both are accepted so the existing
// redFinance consumer keeps working through the migration — the mint script
// only ever writes the encrypted form. Returns null (never throws) so a
// misconfigured key degrades to "no secret, delivery recorded as failed"
// rather than breaking the signing transition that triggered the webhook.
export function readStoredSecret(
  row: Record<string, unknown> | null | undefined,
  rawKey: string | undefined,
  minLength = 16
): { secret: string | null; error: string | null } {
  if (!row) return { secret: null, error: "consumer not found" };
  const encrypted = row.webhookSecretEnc;
  if (isEncryptedBlob(encrypted)) {
    try {
      const secret = decryptSecret(parseSecretsKey(rawKey), encrypted);
      return secret.length >= minLength
        ? { secret, error: null }
        : { secret: null, error: "decrypted webhook secret is too short" };
    } catch (e) {
      return { secret: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const legacy = row.webhookSecret;
  if (typeof legacy === "string" && legacy.length >= minLength) {
    return { secret: legacy, error: null };
  }
  return { secret: null, error: "no webhook secret on the consumer row" };
}
