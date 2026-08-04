import crypto from "node:crypto";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import {
  SignField,
  fitImageInBox,
  isCheckedValue,
  relRectToPdf,
} from "./signing";

// Server-side flattening (Phase 3): draw every collected field value into the
// original PDF at its page-relative 0..1 coordinates, then append a
// certificate page (envelope id, document sha256, per-signer audit trail).

export type FlattenSigner = {
  idx: number;
  name: string;
  order?: number | null;
  consentAt?: Date | string | null;
  signedAt?: Date | string | null;
  ip?: string | null;
  userAgent?: string | null;
  values?: Record<string, string>;
};

const INK = rgb(0.08, 0.08, 0.16);
const MUTED = rgb(0.42, 0.42, 0.48);
const RED = rgb(0.937, 0.267, 0.267); // #ef4444

// Helvetica/Courier are WinAnsi-encoded; anything outside (emoji, CJK) makes
// drawText throw mid-flatten, so replace rather than crash.
function winAnsi(s: string): string {
  return s.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "?");
}

function fmt(d: Date | string | null | undefined): string {
  return d ? new Date(d).toISOString() : "n/a";
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(probe, size) <= maxWidth) {
      line = probe;
      continue;
    }
    if (line) lines.push(line);
    // A single over-long word (URLs, UA tokens) gets hard-chopped.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function drawTextInBox(page: PDFPage, font: PDFFont, text: string, box: { x: number; y: number; w: number; h: number }) {
  let size = Math.min(12, Math.max(6, box.h * 0.65));
  while (size > 5 && font.widthOfTextAtSize(text, size) > box.w - 4) size -= 0.5;
  page.drawText(text, {
    x: box.x + 2,
    y: box.y + (box.h - size * 0.7) / 2,
    size,
    font,
    color: INK,
  });
}

export async function buildExecutedPdf(opts: {
  original: Buffer | Uint8Array;
  envelopeId: string;
  documentName: string;
  fields: SignField[];
  signers: FlattenSigner[];
  completedAt: Date;
}): Promise<Uint8Array> {
  const { original, envelopeId, documentName, fields, signers, completedAt } = opts;
  const sha256 = crypto.createHash("sha256").update(original).digest("hex");

  const doc = await PDFDocument.load(original);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const pages = doc.getPages();
  const byIdx = new Map(signers.map((s) => [s.idx, s]));

  // --- flatten field values onto the original pages ---
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const value = byIdx.get(field.signerIdx)?.values?.[String(i)];
    if (!value) continue;
    const page = pages[field.page - 1];
    if (!page) continue;
    const box = relRectToPdf(field, page.getWidth(), page.getHeight());

    if (field.type === "signature" || field.type === "initials") {
      const png = await doc.embedPng(value);
      const fit = fitImageInBox(png.width, png.height, box);
      if (fit.w > 0 && fit.h > 0) page.drawImage(png, fit);
    } else if (field.type === "checkbox") {
      if (isCheckedValue(value)) {
        const size = Math.max(6, box.h * 0.8);
        const w = bold.widthOfTextAtSize("X", size);
        page.drawText("X", {
          x: box.x + (box.w - w) / 2,
          y: box.y + (box.h - size * 0.7) / 2,
          size,
          font: bold,
          color: INK,
        });
      }
    } else {
      drawTextInBox(page, font, winAnsi(value), box);
    }
  }

  // --- certificate page(s) ---
  const PAGE_W = 612;
  const PAGE_H = 792;
  const LEFT = 56;
  const WIDTH = PAGE_W - LEFT * 2;
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 64;

  const footer = (p: PDFPage) => {
    p.drawText("Executed via redSign", { x: LEFT, y: 40, size: 9, font: bold, color: RED });
    p.drawText("sign.redbtn.io", {
      x: LEFT + bold.widthOfTextAtSize("Executed via redSign", 9) + 8,
      y: 40,
      size: 9,
      font,
      color: MUTED,
    });
  };
  const ensureRoom = (needed: number) => {
    if (y - needed < 72) {
      footer(page);
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - 64;
    }
  };
  const line = (
    text: string,
    o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number } = {}
  ) => {
    const size = o.size ?? 10;
    const f = o.font ?? font;
    for (const l of wrapText(winAnsi(text), f, size, WIDTH)) {
      ensureRoom(size + 4);
      page.drawText(l, { x: LEFT, y, size, font: f, color: o.color ?? INK });
      y -= size + 4;
    }
    y -= o.gap ?? 0;
  };

  line("Signature Certificate", { size: 20, font: bold, gap: 10 });
  line(`Envelope: ${envelopeId}`, { gap: 2 });
  line(`Document: ${documentName}`, { gap: 2 });
  line(`Completed: ${fmt(completedAt)}`, { gap: 6 });
  line("SHA-256 of original document:", { size: 9, color: MUTED });
  line(sha256, { size: 9, font: mono, gap: 12 });

  page.drawLine({
    start: { x: LEFT, y: y + 6 },
    end: { x: PAGE_W - LEFT, y: y + 6 },
    thickness: 0.75,
    color: MUTED,
  });
  y -= 10;

  const ordered = [...signers].sort(
    (a, b) => (a.order ?? a.idx) - (b.order ?? b.idx) || a.idx - b.idx
  );
  for (const s of ordered) {
    ensureRoom(80);
    line(`Signer ${s.idx + 1}: ${s.name}`, { size: 12, font: bold, gap: 2 });
    line(`Consented to electronic signature: ${fmt(s.consentAt)}`, { size: 9, gap: 1 });
    line(`Signed: ${fmt(s.signedAt)}`, { size: 9, gap: 1 });
    line(`IP address: ${s.ip || "n/a"}`, { size: 9, gap: 1 });
    line(`Device: ${s.userAgent || "n/a"}`, { size: 9, color: MUTED, gap: 10 });
  }

  footer(page);
  return await doc.save();
}
