import crypto from "node:crypto";
import { GridFSBucket, ObjectId } from "mongodb";
import { getDb } from "./db";
import { accessCodeError } from "./policy";

// Envelope model per docs/ENVELOPE-API.md (adopted v0).
// Field coordinates are page-relative 0..1 so they survive render scaling.

export type EnvelopeStatus = "draft" | "sent" | "completed" | "declined" | "voided";
export type FieldType = "signature" | "initials" | "date" | "text" | "checkbox";

export interface SignerInput {
  name: string;
  email?: string;
  phone?: string;
  order?: number;
  // v0.2: optional out-of-band second factor on the signing link. Kept in
  // plaintext only long enough for the create route to HMAC it with the
  // freshly minted token; never stored.
  accessCode?: string;
}

export interface FieldInput {
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  signerIdx: number;
  required?: boolean;
}

const FIELD_TYPES: FieldType[] = ["signature", "initials", "date", "text", "checkbox"];

export function validateSigners(raw: unknown): SignerInput[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10) {
    throw new Error("1-10 signers required");
  }
  return raw.map((s, i) => {
    const name = String(s?.name ?? "").trim().slice(0, 200);
    if (!name) throw new Error(`signer ${i}: name required`);
    const email = s?.email ? String(s.email).trim().slice(0, 200) : undefined;
    if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      throw new Error(`signer ${i}: email is not a valid address`);
    }
    if (s?.accessCode != null && s.accessCode !== "") {
      const err = accessCodeError(s.accessCode);
      if (err) throw new Error(`signer ${i}: ${err}`);
    }
    return {
      name,
      email,
      phone: s?.phone ? String(s.phone).slice(0, 40) : undefined,
      order: Number.isInteger(s?.order) ? s.order : i,
      accessCode: s?.accessCode ? String(s.accessCode) : undefined,
    };
  });
}

export function validateFields(raw: unknown, signerCount: number): FieldInput[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 200) {
    throw new Error("1-200 fields required");
  }
  return raw.map((f, i) => {
    if (!FIELD_TYPES.includes(f?.type)) throw new Error(`field ${i}: bad type`);
    const page = Number(f?.page);
    if (!Number.isInteger(page) || page < 1) throw new Error(`field ${i}: page must be >= 1`);
    for (const k of ["x", "y", "w", "h"] as const) {
      const v = Number(f?.[k]);
      if (!(v >= 0 && v <= 1)) throw new Error(`field ${i}: ${k} must be 0..1`);
    }
    const signerIdx = Number(f?.signerIdx);
    if (!Number.isInteger(signerIdx) || signerIdx < 0 || signerIdx >= signerCount) {
      throw new Error(`field ${i}: signerIdx out of range`);
    }
    return {
      type: f.type,
      page,
      x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h),
      signerIdx,
      required: f?.required !== false,
    };
  });
}

export function mintToken(): string {
  return crypto.randomBytes(24).toString("hex"); // 48-hex signer link token
}

// --- consumer service keys (x-redsign-key), hashed at rest ---

export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// v0.2: the consumer row carries more than a name. `platform` marks a
// multi-tenant caller (redOffice) whose envelopes must assert metadata.orgId;
// `orgId` pins a single-tenant consumer to one org.
export type ConsumerIdentity = {
  name: string;
  platform: boolean;
  orgId: string | null;
};

export async function verifyConsumerKey(key: string | null): Promise<ConsumerIdentity | null> {
  if (!key || key.length < 16) return null;
  const db = await getDb();
  const row = await db.collection("consumers").findOne({ keyHash: hashKey(key), active: true });
  if (!row) return null;
  return {
    name: String(row.name),
    platform: row.platform === true,
    orgId: typeof row.orgId === "string" && row.orgId ? row.orgId : null,
  };
}

// SHA-256 of a stored PDF, hex. Used for documentSha256 at creation and
// executedSha256 at completion.
export function sha256Hex(buf: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// --- GridFS PDF storage ---

export function pdfBucket(db: Awaited<ReturnType<typeof getDb>>): GridFSBucket {
  return new GridFSBucket(db, { bucketName: "pdfs" });
}

export async function storePdf(buf: Buffer, filename: string, meta: Record<string, unknown>): Promise<string> {
  const db = await getDb();
  const bucket = pdfBucket(db);
  return await new Promise<string>((resolve, reject) => {
    const up = bucket.openUploadStream(filename, { metadata: meta });
    up.on("error", reject);
    up.on("finish", () => resolve(String(up.id)));
    up.end(buf);
  });
}

export async function readPdf(fileId: string): Promise<{ stream: NodeJS.ReadableStream } | null> {
  const db = await getDb();
  const file = await db.collection("pdfs.files").findOne({ _id: new ObjectId(fileId) });
  if (!file) return null;
  return { stream: pdfBucket(db).openDownloadStream(new ObjectId(fileId)) };
}

// Whole-file read for the flattener (pdf-lib wants the full buffer).
export async function readPdfBuffer(fileId: string): Promise<Buffer | null> {
  const pdf = await readPdf(fileId);
  if (!pdf) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of pdf.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
