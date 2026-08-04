// Pure signing-flow logic (Phase 3): token shape, sequential ordering,
// field-value validation, and the 0..1 -> PDF-point coordinate math the
// flattener uses. Dependency-free on purpose: unit tests run under
// `node --test` with type stripping, which cannot resolve the extensionless
// imports lib/db.ts / lib/envelopes.ts pull in.

export const SIGNING_TOKEN_RE = /^[a-f0-9]{48}$/;

export function isValidSigningToken(token: unknown): token is string {
  return typeof token === "string" && SIGNING_TOKEN_RE.test(token);
}

export type TurnSigner = {
  idx: number;
  name: string;
  status: string;
  order?: number | null;
};

// Sequential ordering: a signer may sign only when the envelope is `sent`,
// they are still `pending`, and every signer that comes before them — lower
// `order`, ties broken by `idx` — has signed. `waitingOn` names the first
// blocking signer (the "waiting on X" screen), independent of canSign.
export function signingTurn(
  envelopeStatus: string,
  signers: TurnSigner[],
  idx: number
): { canSign: boolean; waitingOn: string | null } {
  const me = signers.find((s) => s.idx === idx);
  if (!me) return { canSign: false, waitingOn: null };
  const rank = (s: TurnSigner): [number, number] => [s.order ?? s.idx, s.idx];
  const cmp = (a: TurnSigner, b: TurnSigner) => {
    const [ao, ai] = rank(a);
    const [bo, bi] = rank(b);
    return ao - bo || ai - bi;
  };
  const blockers = signers
    .filter((s) => cmp(s, me) < 0 && s.status !== "signed")
    .sort(cmp);
  const waitingOn = blockers.length ? blockers[0].name : null;
  const canSign =
    envelopeStatus === "sent" && me.status === "pending" && !blockers.length;
  return { canSign, waitingOn };
}

export type SignFieldType = "signature" | "initials" | "date" | "text" | "checkbox";

export type SignField = {
  type: SignFieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  signerIdx: number;
  required?: boolean;
};

export type SignerFieldEntry = { key: string; field: SignField };

// Field values are keyed by the field's absolute index in envelope.fields —
// the only stable identity fields carry (they have no ids of their own).
export function signerFieldEntries(
  fields: SignField[],
  signerIdx: number
): SignerFieldEntry[] {
  return fields
    .map((field, i) => ({ key: String(i), field }))
    .filter((e) => e.field.signerIdx === signerIdx);
}

export const MAX_SIGNATURE_IMAGE_BYTES = 1024 * 1024; // per-image data URL cap
export const MAX_TOTAL_VALUES_BYTES = 10 * 1024 * 1024; // per-complete cap
export const MAX_TEXT_VALUE_CHARS = 500;

const PNG_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

// null = acceptable, string = rejection reason.
export function fieldValueError(type: SignFieldType, value: string): string | null {
  if (type === "signature" || type === "initials") {
    if (!PNG_DATA_URL_RE.test(value)) return "must be a PNG data URL";
    if (value.length > MAX_SIGNATURE_IMAGE_BYTES) return "image exceeds 1MB";
    return null;
  }
  if (value.length > MAX_TEXT_VALUE_CHARS) {
    return `must be at most ${MAX_TEXT_VALUE_CHARS} characters`;
  }
  return null;
}

export function isCheckedValue(value: string): boolean {
  return ["true", "on", "1", "yes", "checked", "x"].includes(value.trim().toLowerCase());
}

// Keys of this signer's required fields that have no usable value yet.
export function missingRequiredKeys(
  fields: SignField[],
  signerIdx: number,
  values: Record<string, string | undefined>
): string[] {
  return signerFieldEntries(fields, signerIdx)
    .filter(({ key, field }) => field.required !== false && !(values[key] ?? "").trim())
    .map(({ key }) => key);
}

export type Box = { x: number; y: number; w: number; h: number };

// Field rects are page-relative 0..1 with a TOP-LEFT origin (browser
// convention: the composer measured DOM pixels). PDF user space has a
// BOTTOM-LEFT origin, so y flips through the page height.
export function relRectToPdf(rect: Box, pageWidth: number, pageHeight: number): Box {
  return {
    x: rect.x * pageWidth,
    y: pageHeight - (rect.y + rect.h) * pageHeight,
    w: rect.w * pageWidth,
    h: rect.h * pageHeight,
  };
}

// Center an image of natural size iw x ih inside `box`, preserving aspect.
export function fitImageInBox(iw: number, ih: number, box: Box): Box {
  if (iw <= 0 || ih <= 0 || box.w <= 0 || box.h <= 0) {
    return { x: box.x, y: box.y, w: 0, h: 0 };
  }
  const scale = Math.min(box.w / iw, box.h / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
