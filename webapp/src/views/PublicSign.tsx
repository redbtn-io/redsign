import "../utils/setupPdf";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Document, Page } from "react-pdf";
import { createPortal } from "react-dom";
import { Button, Dialog, DialogContent } from "@redbtn/redstyle";
import { SignatureCanvas } from "../components/SignatureCanvas";
import { relToPx } from "../utils/composeFields";
import { isValidSigningToken, type SignField } from "../lib/signing";

// Public signing page (Phase 3): what an external signer sees when they open
// a 48-hex signing link. Standalone and mobile-first (390x844 is the primary
// viewport) — no sender shell, no auth, no cookies required.

type SignerField = {
  key: string;
  type: SignField["type"];
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
};

type SignState = {
  envelope: { documentName: string; status: string };
  signer: { idx: number; name: string; status: string };
  fields: SignerField[];
  canSign: boolean;
  waitingOn: string | null;
};

type Phase = "loading" | "notfound" | "voided" | "failed" | "ready" | "success";

const COLORS = {
  bg: "#f4f4f5",
  card: "#ffffff",
  ink: "#18181b",
  muted: "#71717a",
  border: "#e4e4e7",
  red: "#ef4444",
  redSoft: "rgba(239,68,68,0.08)",
  green: "#16a34a",
};

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Wordmark() {
  return (
    <span style={{ fontWeight: 700, fontSize: 18, color: COLORS.ink }}>
      red<span style={{ color: COLORS.red }}>Sign</span>
    </span>
  );
}

// Full-screen framed message (404 / voided / waiting / done states).
function Notice({
  title,
  body,
  testId,
}: {
  title: string;
  body: string;
  testId: string;
}) {
  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: COLORS.bg,
        padding: 24,
      }}
    >
      <div
        data-testid={testId}
        style={{
          background: COLORS.card,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 12,
          padding: "32px 28px",
          maxWidth: 420,
          textAlign: "center",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        <div style={{ marginBottom: 14 }}>
          <Wordmark />
        </div>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: COLORS.ink, margin: "0 0 10px" }}>
          {title}
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: COLORS.muted, margin: 0 }}>{body}</p>
      </div>
    </div>
  );
}

export default function PublicSign({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [state, setState] = useState<SignState | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [signingKey, setSigningKey] = useState<string | null>(null);
  const [pdfWidth, setPdfWidth] = useState(() =>
    typeof window === "undefined" ? 600 : Math.min(window.innerWidth - 24, 760)
  );
  const pageWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onResize = () => setPdfWidth(Math.min(window.innerWidth - 24, 760));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isValidSigningToken(token)) {
        setPhase("notfound");
        return;
      }
      try {
        const res = await fetch(`/api/sign/${token}`);
        if (res.status === 404) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) setPhase(body?.error === "voided" ? "voided" : "notfound");
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: SignState = await res.json();
        if (cancelled) return;
        // Date fields prefill with today's date (still editable).
        const prefill: Record<string, string> = {};
        for (const f of data.fields) if (f.type === "date") prefill[f.key] = todayLabel();
        setValues(prefill);
        setState(data);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const measurePage = useCallback(() => {
    const el = pageWrapRef.current?.querySelector(".react-pdf__Page") as HTMLElement | null;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      setPageSize({ width: el.clientWidth, height: el.clientHeight });
    }
  }, []);

  if (phase === "loading") {
    return (
      <div
        style={{
          height: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: COLORS.bg,
          color: COLORS.muted,
          fontSize: 14,
        }}
      >
        Loading…
      </div>
    );
  }
  if (phase === "notfound") {
    return (
      <Notice
        testId="sign-notfound"
        title="This signing link isn't valid"
        body="The link may be mistyped or no longer active. Ask the sender for a fresh signing link."
      />
    );
  }
  if (phase === "voided") {
    return (
      <Notice
        testId="sign-voided"
        title="This document was voided"
        body="The sender cancelled this envelope, so it can no longer be signed. Ask the sender for a new one if you believe this is a mistake."
      />
    );
  }
  if (phase === "failed") {
    return (
      <Notice
        testId="sign-failed"
        title="Something went wrong"
        body="We couldn't load this signing request. Check your connection and reload the page."
      />
    );
  }

  const s = state!;

  if (phase === "success") {
    return (
      <Notice
        testId="sign-success"
        title={`You're done — ${s.signer.name} signed ${s.envelope.documentName}`}
        body="Your signature has been recorded. The sender will receive the completed document."
      />
    );
  }
  if (s.envelope.status === "completed") {
    return (
      <Notice
        testId="sign-completed"
        title="This document is complete"
        body={`Every signer has finished and ${s.envelope.documentName} has been executed. The sender will distribute the signed copy.`}
      />
    );
  }
  if (s.signer.status === "signed") {
    return (
      <Notice
        testId="sign-already"
        title={`You've already signed, ${s.signer.name}`}
        body={
          s.waitingOn
            ? `Nothing else to do here — waiting on ${s.waitingOn} to finish.`
            : "Nothing else to do here. The sender will receive the completed document."
        }
      />
    );
  }
  if (!s.canSign) {
    return (
      <Notice
        testId="waiting-on"
        title={`It's not your turn yet`}
        body={
          s.waitingOn
            ? `${s.waitingOn} needs to sign ${s.envelope.documentName} before you. You'll be able to sign once they finish — check back soon.`
            : `This envelope isn't ready for signing (status: ${s.envelope.status}).`
        }
      />
    );
  }

  // --- canSign: the actual signing UI ---
  const fieldsOnPage = s.fields.filter((f) => f.page === currentPage);
  // Keys come from the API (absolute index in envelope.fields) — do NOT
  // re-derive them from this signer's filtered array, the indices differ.
  const missing = s.fields
    .filter((f) => f.required && !(values[f.key] ?? "").trim())
    .map((f) => f.key);
  const otherPagesNeedInput = missing.some(
    (key) => s.fields.find((f) => f.key === key)?.page !== currentPage
  );
  const readyToFinish = consent && missing.length === 0 && !submitting;

  async function finish() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/sign/${token}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true, values }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(String(body?.error ?? `status ${res.status}`));
        return;
      }
      setPhase("success");
    } catch {
      setSubmitError("Network error — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function fieldBox(f: SignerField) {
    if (!pageSize) return null;
    const px = relToPx(f, pageSize);
    const value = values[f.key];
    const base: CSSProperties = {
      position: "absolute",
      left: px.x,
      top: px.y,
      width: px.w,
      height: px.h,
      boxSizing: "border-box",
      pointerEvents: "auto",
    };
    if (f.type === "signature" || f.type === "initials") {
      return (
        <button
          key={f.key}
          data-testid={`sign-field-${f.key}`}
          onClick={() => setSigningKey(f.key)}
          style={{
            ...base,
            border: `2px dashed ${value ? COLORS.green : COLORS.red}`,
            borderRadius: 4,
            background: value ? "rgba(22,163,74,0.06)" : COLORS.redSoft,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            overflow: "hidden",
          }}
        >
          {value ? (
            <img
              src={value}
              alt="Your signature"
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ) : (
            <span style={{ fontSize: Math.min(13, px.h * 0.45), color: COLORS.red, fontWeight: 600 }}>
              {f.type === "initials" ? "Tap to initial" : "Tap to sign"}
              {f.required ? " *" : ""}
            </span>
          )}
        </button>
      );
    }
    if (f.type === "checkbox") {
      return (
        <label key={f.key} style={{ ...base, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <input
            type="checkbox"
            data-testid={`sign-field-${f.key}`}
            checked={values[f.key] === "true"}
            onChange={(e) =>
              setValues((v) => ({ ...v, [f.key]: e.target.checked ? "true" : "" }))
            }
            style={{ width: "70%", height: "70%", accentColor: COLORS.red }}
          />
        </label>
      );
    }
    // date / text
    return (
      <input
        key={f.key}
        data-testid={`sign-field-${f.key}`}
        value={values[f.key] ?? ""}
        placeholder={f.type === "date" ? "Date" : `Text${f.required ? " *" : ""}`}
        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
        style={{
          ...base,
          border: `1.5px dashed ${(values[f.key] ?? "").trim() ? COLORS.green : COLORS.red}`,
          borderRadius: 4,
          background: "rgba(255,255,255,0.85)",
          fontSize: Math.min(14, px.h * 0.55),
          color: COLORS.ink,
          padding: "0 4px",
        }}
      />
    );
  }

  const signatureDialog = (
    <Dialog open={Boolean(signingKey)} onOpenChange={(open) => !open && setSigningKey(null)}>
      <DialogContent className="w-full max-w-none p-0">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: 12,
            maxWidth: "100%",
          }}
        >
          <p style={{ fontSize: 13, color: COLORS.muted, margin: "0 0 8px" }}>
            Draw your {s.fields.find((f) => f.key === signingKey)?.type === "initials" ? "initials" : "signature"} below
          </p>
          <SignatureCanvas
            width={Math.min(typeof window === "undefined" ? 400 : window.innerWidth - 72, 400)}
            defaultValue={signingKey ? values[signingKey] : undefined}
            onCancel={() => setSigningKey(null)}
            onSave={(dataUrl) => {
              if (signingKey) setValues((v) => ({ ...v, [signingKey]: dataUrl }));
              setSigningKey(null);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );

  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: COLORS.bg,
        color: COLORS.ink,
      }}
    >
      <header
        style={{
          background: COLORS.card,
          borderBottom: `1px solid ${COLORS.border}`,
          padding: "10px 16px",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Wordmark />
        <span
          data-testid="sign-signer-name"
          style={{ fontSize: 13, color: COLORS.muted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {s.envelope.documentName} · signing as <strong style={{ color: COLORS.ink }}>{s.signer.name}</strong>
        </span>
      </header>

      <main style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "12px 0 24px" }}>
        <div style={{ width: "fit-content", maxWidth: "100%", margin: "0 auto", padding: "0 12px" }}>
          {pdfError ? (
            <div role="alert" style={{ padding: 40, textAlign: "center", color: COLORS.muted }}>
              Unable to load the document. {pdfError}
            </div>
          ) : (
            <Document
              file={`/api/sign/${token}/document`}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              onLoadError={(err) => setPdfError(err?.message ?? "")}
              loading={<div style={{ padding: 40, color: COLORS.muted, fontSize: 14 }}>Loading document…</div>}
            >
              <div
                ref={pageWrapRef}
                style={{
                  position: "relative",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
                  background: "#fff",
                }}
              >
                <Page
                  pageNumber={currentPage}
                  width={pdfWidth}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  onRenderSuccess={measurePage}
                />
                <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                  {pageSize && fieldsOnPage.map((f) => fieldBox(f))}
                </div>
              </div>
            </Document>
          )}
          {numPages !== null && numPages > 1 && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: 8,
                gap: 8,
              }}
            >
              <Button
                data-testid="sign-prev-page"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <span style={{ fontSize: 13, color: COLORS.muted }}>
                Page {currentPage} of {numPages}
                {otherPagesNeedInput ? " · fields remain on other pages" : ""}
              </span>
              <Button
                data-testid="sign-next-page"
                onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
                disabled={currentPage === numPages}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      </main>

      <footer
        style={{
          background: COLORS.card,
          borderTop: `1px solid ${COLORS.border}`,
          padding: "12px 16px calc(12px + env(safe-area-inset-bottom))",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            fontSize: 13,
            lineHeight: 1.5,
            color: COLORS.ink,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            data-testid="sign-consent"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            style={{ marginTop: 2, width: 18, height: 18, accentColor: COLORS.red, flexShrink: 0 }}
          />
          <span>
            I agree to sign this document electronically and that my electronic signature is
            legally binding.
          </span>
        </label>
        {submitError && (
          <p data-testid="sign-error" role="alert" style={{ margin: 0, fontSize: 13, color: COLORS.red }}>
            {submitError}
          </p>
        )}
        <Button
          data-testid="sign-finish"
          onClick={finish}
          disabled={!readyToFinish}
          style={{ width: "100%" }}
        >
          {submitting
            ? "Signing…"
            : missing.length
              ? `${missing.length} required field${missing.length === 1 ? "" : "s"} left`
              : "Sign & finish"}
        </Button>
      </footer>

      {typeof document !== "undefined" && createPortal(signatureDialog, document.body)}
    </div>
  );
}
