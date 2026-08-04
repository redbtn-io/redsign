// Pure helpers for the sender compose flow (Phase 2b).
//
// Field geometry is page-relative 0..1 per docs/ENVELOPE-API.md so placements
// survive render scaling: the composer measures the rendered react-pdf <Page>
// element and converts pixel rects through these helpers before anything is
// sent to POST /api/envelopes.

export type ComposeFieldType = 'signature' | 'date';

export type ComposeSigner = {
  id: string;
  name: string;
  email: string;
};

export type ComposeField = {
  id: string;
  type: ComposeFieldType;
  page: number;
  // page-relative 0..1
  x: number;
  y: number;
  w: number;
  h: number;
  signerId: string;
};

// One distinct chip color per signer slot; length doubles as the signer cap
// (the API rejects more than 10 signers).
export const SIGNER_COLORS = [
  '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
] as const;

export const MAX_SIGNERS = SIGNER_COLORS.length;

export function signerColor(idx: number): string {
  const n = SIGNER_COLORS.length;
  return SIGNER_COLORS[((idx % n) + n) % n];
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export type PageSize = { width: number; height: number };
export type Rect = { x: number; y: number; w: number; h: number };

// Pixel rect (measured against the rendered page element) -> page-relative.
// Clamped so a box nudged against an edge can never leave the 0..1 space the
// API validates, and x/y are capped so the box stays fully on the page.
export function pxToRel(px: Rect, page: PageSize): Rect {
  const w = clamp01(px.w / page.width);
  const h = clamp01(px.h / page.height);
  return {
    x: round4(Math.min(clamp01(px.x / page.width), 1 - w)),
    y: round4(Math.min(clamp01(px.y / page.height), 1 - h)),
    w: round4(w),
    h: round4(h),
  };
}

export function relToPx(rel: Rect, page: PageSize): Rect {
  return {
    x: rel.x * page.width,
    y: rel.y * page.height,
    w: rel.w * page.width,
    h: rel.h * page.height,
  };
}

// Default drop rect for a new field on the current page, cascaded by the
// number of fields already there so repeated drops don't stack invisibly.
export function defaultFieldRect(type: ComposeFieldType, existingOnPage: number): Rect {
  const size = type === 'date' ? { w: 0.18, h: 0.045 } : { w: 0.25, h: 0.06 };
  const step = (existingOnPage % 8) * 0.04;
  return {
    x: round4(clamp01(0.1 + step)),
    y: round4(clamp01(0.12 + step)),
    w: size.w,
    h: size.h,
  };
}

export function firstName(name: string, idx: number): string {
  const first = name.trim().split(/\s+/)[0];
  return first || `Signer ${idx + 1}`;
}

export type EnvelopePayload = {
  signers: { name: string; email?: string }[];
  fields: {
    type: ComposeFieldType;
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
    signerIdx: number;
  }[];
  metadata: Record<string, unknown>;
};

// Assemble the POST /api/envelopes payload. Fields referencing a removed
// signer are dropped rather than sent with a dangling signerIdx.
export function buildEnvelopePayload(
  signers: ComposeSigner[],
  fields: ComposeField[],
  metadata: Record<string, unknown> = {},
): EnvelopePayload {
  const idxById = new Map(signers.map((s, i) => [s.id, i] as const));
  return {
    signers: signers.map((s) => {
      const name = s.name.trim();
      const email = s.email.trim();
      return email ? { name, email } : { name };
    }),
    fields: fields
      .filter((f) => idxById.has(f.signerId))
      .map((f) => ({
        type: f.type,
        page: f.page,
        x: round4(clamp01(f.x)),
        y: round4(clamp01(f.y)),
        w: round4(clamp01(f.w)),
        h: round4(clamp01(f.h)),
        signerIdx: idxById.get(f.signerId)!,
      })),
    metadata: { source: 'composer', ...metadata },
  };
}

// Send is allowed once every signer has a name and at least one field is
// placed for a still-existing signer. Returns null when sendable.
export function composeValidationError(
  signers: ComposeSigner[],
  fields: ComposeField[],
): string | null {
  if (!signers.length) return 'Add at least one signer.';
  if (signers.length > MAX_SIGNERS) return `At most ${MAX_SIGNERS} signers.`;
  if (signers.some((s) => !s.name.trim())) return 'Every signer needs a name.';
  const ids = new Set(signers.map((s) => s.id));
  if (!fields.some((f) => ids.has(f.signerId))) {
    return 'Place at least one field on the document.';
  }
  return null;
}
