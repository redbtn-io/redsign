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

// The ESIGN disclosure the signer has to be shown before consenting (v0.2).
// The server owns the text and its version; the page only renders it and
// echoes the version back when recording consent.
type Disclosure = {
  version: string;
  kind: string;
  title: string;
  sections: { heading: string; body: string }[];
  acknowledgement: string;
};

type SignState = {
  envelope: { documentName: string; status: string; expiresAt?: string | null };
  signer: { idx: number; name: string; status: string; consentAt?: string | null };
  disclosure: Disclosure;
  fields: SignerField[];
  canSign: boolean;
  waitingOn: string | null;
};

type Phase =
  | "loading"
  | "notfound"
  | "voided"
  | "expired"
  | "accesscode"
  | "failed"
  | "ready"
  | "success";

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
  const [showDisclosure, setShowDisclosure] = useState(false);
  // Optional out-of-band access code on the signing link. Held in memory only:
  // persisting it would defeat the point of a second factor on a shared device.
  const [accessCode, setAccessCode] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
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

  // One loader, reusable: the first render calls it with no code, and the
  // access-code screen calls it again once the signer supplies one.
  const load = useCallback(
    async (code: string, signal?: { cancelled: boolean }) => {
      if (!isValidSigningToken(token)) {
        setPhase("notfound");
        return;
      }
      try {
        const res = await fetch(`/api/sign/${token}`, {
          headers: code ? { "x-redsign-access-code": code } : undefined,
        });
        if (res.status === 401) {
          if (signal?.cancelled) return;
          setCodeError(code ? "That code doesn't match. Check it with the sender." : null);
          setPhase("accesscode");
          return;
        }
        if (res.status === 404) {
          const body = await res.json().catch(() => ({}));
          if (signal?.cancelled) return;
          setPhase(
            body?.error === "voided" ? "voided" : body?.error === "expired" ? "expired" : "notfound"
          );
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: SignState = await res.json();
        if (signal?.cancelled) return;
        // Date fields prefill with today's date (still editable).
        const prefill: Record<string, string> = {};
        for (const f of data.fields) if (f.type === "date") prefill[f.key] = todayLabel();
        setValues(prefill);
        setState(data);
        setCodeError(null);
        // A signer who already consented (their /consent call landed before
        // they lost the page) does not have to tick the box twice.
        setConsent(Boolean(data.signer.consentAt));
        setPhase("ready");
      } catch {
        if (!signal?.cancelled) setPhase("failed");
      }
    },
    [token]
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load("", signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

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
  if (phase === "expired") {
    return (
      <Notice
        testId="sign-expired"
        title="This signing link has expired"
        body="The sender set an expiry on this envelope and it has passed, so it can no longer be signed. Ask the sender to send a new one."
      />
    );
  }
  if (phase === "accesscode") {
    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: COLORS.bg,
          padding: 24,
        }}
      >
        <form
          data-testid="sign-accesscode"
          onSubmit={(e) => {
            e.preventDefault();
            setAccessCode(codeInput);
            setPhase("loading");
            void load(codeInput);
          }}
          style={{
            background: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 12,
            padding: "28px 24px",
            width: "100%",
            maxWidth: 380,
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <Wordmark />
          </div>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: COLORS.ink, margin: "0 0 8px" }}>
            Enter your access code
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: COLORS.muted, margin: "0 0 16px" }}>
            The sender gave you a code separately from this link. Enter it to open the document.
          </p>
          <input
            data-testid="accesscode-input"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            autoComplete="one-time-code"
            autoFocus
            aria-label="Access code"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "11px 12px",
              fontSize: 16,
              letterSpacing: 1,
              border: `1.5px solid ${codeError ? COLORS.red : COLORS.border}`,
              borderRadius: 8,
              marginBottom: 12,
            }}
          />
          {codeError && (
            <p
              data-testid="accesscode-error"
              role="alert"
              style={{ margin: "0 0 12px", fontSize: 13, color: COLORS.red }}
            >
              {codeError}
            </p>
          )}
          <Button type="submit" disabled={!codeInput.trim()} style={{ width: "100%" }}>
            Continue
          </Button>
        </form>
      </div>
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

  // Consent is recorded the moment the box is ticked, on the server's clock,
  // with the disclosure version the signer was actually shown. Recording it
  // only at completion would timestamp the wrong act. A failure here is not
  // fatal: /complete still records consent inline, so the signer is never
  // blocked by a transient network error on a side call.
  async function recordConsent() {
    try {
      await fetch(`/api/sign/${token}/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessCode ? { "x-redsign-access-code": accessCode } : {}),
        },
        body: JSON.stringify({ consent: true, disclosureVersion: s.disclosure?.version }),
      });
    } catch {
      // deliberately swallowed, see above
    }
  }

  async function finish() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/sign/${token}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessCode ? { "x-redsign-access-code": accessCode } : {}),
        },
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
              file={`/api/sign/${token}/document${accessCode ? `?code=${encodeURIComponent(accessCode)}` : ""}`}
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
        {s.disclosure && (
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              background: COLORS.bg,
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              data-testid="disclosure-toggle"
              aria-expanded={showDisclosure}
              onClick={() => setShowDisclosure((v) => !v)}
              style={{
                width: "100%",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                background: "transparent",
                border: "none",
                textAlign: "left",
                font: "inherit",
                fontSize: 13,
                fontWeight: 600,
                color: COLORS.ink,
                cursor: "pointer",
              }}
            >
              <span>{s.disclosure.title}</span>
              <span style={{ color: COLORS.muted, fontWeight: 400 }}>
                {showDisclosure ? "Hide" : "Read"}
              </span>
            </button>
            {showDisclosure && (
              <div
                data-testid="disclosure-body"
                style={{
                  padding: "0 12px 12px",
                  maxHeight: "40dvh",
                  overflowY: "auto",
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color: COLORS.ink,
                }}
              >
                {s.disclosure.sections.map((sec) => (
                  <div key={sec.heading} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>{sec.heading}</div>
                    <div style={{ color: COLORS.muted }}>{sec.body}</div>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: COLORS.muted }}>
                  Disclosure version {s.disclosure.version}
                </div>
              </div>
            )}
          </div>
        )}
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
            onChange={(e) => {
              setConsent(e.target.checked);
              if (e.target.checked) void recordConsent();
            }}
            style={{ marginTop: 2, width: 18, height: 18, accentColor: COLORS.red, flexShrink: 0 }}
          />
          <span>
            {s.disclosure?.acknowledgement ??
              "I agree to sign this document electronically and that my electronic signature is legally binding."}
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
