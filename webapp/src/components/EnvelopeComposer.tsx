import React, { useCallback, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';
import { Rnd } from 'react-rnd';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@redbtn/redstyle';
import '../utils/setupPdf';
import { Breakpoint } from '../types/breakpoint';
import {
  ComposeField,
  ComposeFieldType,
  ComposeSigner,
  MAX_SIGNERS,
  PageSize,
  buildEnvelopePayload,
  composeValidationError,
  defaultFieldRect,
  firstName,
  pxToRel,
  relToPx,
  signerColor,
} from '../utils/composeFields';

// Sender compose flow (Phase 2b): pick signers, drop per-signer fields on the
// rendered PDF, POST /api/envelopes, hand back live signing links.
//
// Coordinates: boxes live in state as page-relative 0..1 rects; the rendered
// react-pdf <Page> element is measured on every render success and rects are
// converted at the react-rnd boundary (see composeFields.ts).

type SentResult = {
  envelopeId: string;
  signers: { idx: number; signingUrl: string }[];
};

type Props = {
  pdfFile: File;
  pdfUrl: string;
  breakpoint: Breakpoint | null;
};

function newId(): string {
  return crypto.randomUUID();
}

export default function EnvelopeComposer({ pdfFile, pdfUrl, breakpoint }: Props) {
  const [signers, setSigners] = useState<ComposeSigner[]>(() => [
    { id: newId(), name: '', email: '' },
  ]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [fields, setFields] = useState<ComposeField[]>([]);
  const [fieldType, setFieldType] = useState<ComposeFieldType>('signature');
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<PageSize | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [result, setResult] = useState<SentResult | null>(null);
  const [sentSignerNames, setSentSignerNames] = useState<string[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const pageWrapRef = useRef<HTMLDivElement | null>(null);

  const selectedSigner =
    signers.find((s) => s.id === selectedId) ?? signers[0] ?? null;
  const selectedIdx = selectedSigner
    ? signers.findIndex((s) => s.id === selectedSigner.id)
    : -1;
  const validationError = composeValidationError(signers, fields);

  // Same sizing table as PDFView so both modes render at familiar widths.
  function pdfSize() {
    switch (breakpoint) {
      case 'sm':
        return window.innerWidth < 640 ? window.innerWidth - 20 : 300;
      case 'md':
        return window.innerWidth < 640 ? window.innerWidth - 20 : 400;
      case 'lg':
        return 500;
      case 'xl':
        return 600;
      case '2xl':
        return 700;
      default:
        return 600;
    }
  }

  const measurePage = useCallback(() => {
    const el = pageWrapRef.current?.querySelector('.react-pdf__Page') as HTMLElement | null;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      setPageSize({ width: el.clientWidth, height: el.clientHeight });
    }
  }, []);

  function addSigner() {
    if (signers.length >= MAX_SIGNERS) return;
    const s: ComposeSigner = { id: newId(), name: '', email: '' };
    setSigners((prev) => [...prev, s]);
    setSelectedId(s.id);
  }

  function removeSigner(id: string) {
    setSigners((prev) => prev.filter((s) => s.id !== id));
    setFields((prev) => prev.filter((f) => f.signerId !== id));
  }

  function updateSigner(id: string, patch: Partial<Pick<ComposeSigner, 'name' | 'email'>>) {
    setSigners((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function addField() {
    if (!selectedSigner || !pageSize) return;
    const onPage = fields.filter((f) => f.page === currentPage).length;
    const rect = defaultFieldRect(fieldType, onPage);
    setFields((prev) => [
      ...prev,
      { id: newId(), type: fieldType, page: currentPage, signerId: selectedSigner.id, ...rect },
    ]);
  }

  function removeField(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id));
  }

  function updateFieldRect(id: string, patch: Partial<Pick<ComposeField, 'x' | 'y' | 'w' | 'h'>>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  async function send() {
    if (validationError || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const isE2E = new URLSearchParams(window.location.search).get('e2e') === '1';
      const payload = buildEnvelopePayload(signers, fields, isE2E ? { e2e: true } : {});
      const fd = new FormData();
      fd.append('document', pdfFile, pdfFile.name || 'document.pdf');
      fd.append('payload', JSON.stringify(payload));
      // Same-origin: the red_session cookie rides along automatically.
      const res = await fetch('/api/envelopes', { method: 'POST', body: fd });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : `Request failed (${res.status})`;
        throw new Error(message);
      }
      setSentSignerNames(signers.map((s) => s.name.trim()));
      setResult(body as SentResult);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  async function copyLink(idx: number, url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API can be unavailable (permissions, http) — legacy fallback.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedIdx(idx);
    window.setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1600);
  }

  if (result) {
    return (
      // Plain wrapper carries the testid: redstyle Card only forwards
      // children + className, data-* props get dropped.
      <div className="mt-5" data-testid="composer-result">
      <Card>
        <CardHeader className="gap-1.5">
          <CardTitle>Envelope sent</CardTitle>
          <CardDescription>Envelope {result.envelopeId}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-text-secondary">
            These links are live — anyone with a link can open and sign this document.
            Share each one only with its intended signer.
          </p>
          <div className="flex flex-col gap-3">
            {result.signers.map((s) => (
              <div
                key={s.idx}
                className="flex flex-col gap-2 rounded-md border border-border p-3"
                data-testid="signing-link-row"
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 999,
                      background: signerColor(s.idx),
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  <span className="text-sm font-semibold">
                    {sentSignerNames[s.idx] || `Signer ${s.idx + 1}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <code
                    className="min-w-0 flex-1 break-all rounded bg-bg-subtle px-2 py-1 text-xs"
                    data-testid="signing-link"
                  >
                    {s.signingUrl}
                  </code>
                  <Button
                    variant="outline"
                    onClick={() => copyLink(s.idx, s.signingUrl)}
                    data-testid="copy-link"
                  >
                    {copiedIdx === s.idx ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Signers panel */}
      <div className="flex w-full shrink-0 flex-col gap-4 lg:w-80">
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle>Signers</CardTitle>
            <CardDescription>
              Select a signer, then place their fields on the document.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {signers.map((s, i) => {
                const isSelected = selectedSigner?.id === s.id;
                const color = signerColor(i);
                return (
                  <div
                    key={s.id}
                    data-testid="composer-signer"
                    onClick={() => setSelectedId(s.id)}
                    className="flex flex-col gap-2 rounded-md p-2"
                    style={{
                      // Longhand only — React warns when border and
                      // borderLeft shorthands fight across rerenders.
                      borderTop: `1px solid ${isSelected ? color : 'transparent'}`,
                      borderRight: `1px solid ${isSelected ? color : 'transparent'}`,
                      borderBottom: `1px solid ${isSelected ? color : 'transparent'}`,
                      borderLeft: `4px solid ${color}`,
                      background: isSelected ? `${color}14` : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={`Select signer ${i + 1}`}
                        onClick={() => setSelectedId(s.id)}
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 999,
                          background: color,
                          border: 'none',
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}
                      />
                      <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                        Signer {i + 1}
                        {isSelected ? ' — placing' : ''}
                      </span>
                      {signers.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Remove signer ${i + 1}`}
                          data-testid="composer-remove-signer"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSigner(s.id);
                          }}
                          className="text-text-secondary hover:text-text-primary"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2 }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <Input
                      placeholder="Name (required)"
                      value={s.name}
                      data-testid="signer-name"
                      onChange={(e) => updateSigner(s.id, { name: e.target.value })}
                    />
                    <Input
                      placeholder="Email (optional)"
                      type="email"
                      value={s.email}
                      data-testid="signer-email"
                      onChange={(e) => updateSigner(s.id, { email: e.target.value })}
                    />
                  </div>
                );
              })}
              <Button
                variant="outline"
                onClick={addSigner}
                disabled={signers.length >= MAX_SIGNERS}
                data-testid="composer-add-signer"
              >
                {signers.length >= MAX_SIGNERS ? `Max ${MAX_SIGNERS} signers` : '+ Add signer'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            {sendError && (
              <div
                role="alert"
                data-testid="compose-error"
                className="mb-3 rounded-md border border-border p-2 text-sm"
                style={{ color: '#ef4444' }}
              >
                {sendError}
              </div>
            )}
            <Button
              className="w-full"
              onClick={send}
              disabled={sending || Boolean(validationError)}
              data-testid="composer-send"
            >
              {sending ? 'Sending…' : 'Send for signature'}
            </Button>
            {validationError && (
              <p className="mt-2 text-xs text-text-secondary" data-testid="compose-validation">
                {validationError}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Field placement over the rendered PDF */}
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button
            onClick={addField}
            disabled={!selectedSigner || !pageSize}
            data-testid="composer-add-field"
          >
            + Add {fieldType} field
            {selectedSigner && selectedIdx >= 0
              ? ` for ${firstName(selectedSigner.name, selectedIdx)}`
              : ''}
          </Button>
          <div className="flex gap-1">
            <Button
              variant={fieldType === 'signature' ? 'default' : 'outline'}
              onClick={() => setFieldType('signature')}
              data-testid="field-type-signature"
            >
              Signature
            </Button>
            <Button
              variant={fieldType === 'date' ? 'default' : 'outline'}
              onClick={() => setFieldType('date')}
              data-testid="field-type-date"
            >
              Date
            </Button>
          </div>
        </div>

        {loadError ? (
          <div role="alert" className="my-10 text-center">
            <p>Unable to load the PDF document.</p>
            <p>{loadError}</p>
          </div>
        ) : (
          <Document
            file={pdfUrl}
            onLoadSuccess={({ numPages: n }: { numPages: number }) => setNumPages(n)}
            onLoadError={(e: Error) => setLoadError(e?.message ?? 'Unable to load this PDF document.')}
          >
            <div
              ref={pageWrapRef}
              style={{
                position: 'relative',
                width: 'fit-content',
                maxWidth: '100%',
                margin: '0 auto',
              }}
            >
              <Page
                pageNumber={currentPage}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                width={pdfSize()}
                onRenderSuccess={measurePage}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                }}
              >
                {pageSize &&
                  fields
                    .filter((f) => f.page === currentPage)
                    .map((f) => {
                      const sIdx = signers.findIndex((s) => s.id === f.signerId);
                      if (sIdx === -1) return null;
                      const color = signerColor(sIdx);
                      const px = relToPx(f, pageSize);
                      const label = firstName(signers[sIdx].name, sIdx);
                      return (
                        <Rnd
                          key={f.id}
                          bounds="parent"
                          position={{ x: px.x, y: px.y }}
                          size={{ width: px.w, height: px.h }}
                          onDragStop={(_, d) => {
                            const rel = pxToRel({ x: d.x, y: d.y, w: px.w, h: px.h }, pageSize);
                            updateFieldRect(f.id, { x: rel.x, y: rel.y });
                          }}
                          onResizeStop={(_, __, ref, ___, pos) => {
                            updateFieldRect(
                              f.id,
                              pxToRel(
                                {
                                  x: pos.x,
                                  y: pos.y,
                                  w: parseFloat(ref.style.width),
                                  h: parseFloat(ref.style.height),
                                },
                                pageSize,
                              ),
                            );
                          }}
                          style={{
                            border: `2px solid ${color}`,
                            backgroundColor: `${color}2e`,
                            pointerEvents: 'auto',
                            touchAction: 'none',
                            cursor: 'move',
                          }}
                          className="drag-exclude"
                          data-testid="compose-field"
                        >
                          <div
                            style={{
                              position: 'relative',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '100%',
                              height: '100%',
                              overflow: 'hidden',
                            }}
                          >
                            <span
                              style={{
                                pointerEvents: 'none',
                                fontSize: 12,
                                fontWeight: 600,
                                color,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {label}
                              {f.type === 'date' ? ' · date' : ''}
                            </span>
                            <button
                              type="button"
                              aria-label="Remove field"
                              data-testid="compose-field-remove"
                              onMouseDown={(e) => e.stopPropagation()}
                              onTouchStart={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeField(f.id);
                              }}
                              style={{
                                position: 'absolute',
                                top: 0,
                                right: 0,
                                width: 18,
                                height: 18,
                                border: 'none',
                                background: color,
                                color: '#fff',
                                cursor: 'pointer',
                                borderRadius: '0 0 0 6px',
                                padding: 0,
                                fontSize: 12,
                                lineHeight: '16px',
                                // Above react-rnd's resize handles (rendered
                                // after children, so they'd eat the click).
                                zIndex: 10,
                              }}
                            >
                              ×
                            </button>
                          </div>
                        </Rnd>
                      );
                    })}
              </div>
            </div>
          </Document>
        )}

        {!loadError && (
          <div className="mt-1 flex items-center justify-between gap-2">
            <Button
              onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
              disabled={currentPage === 1}
            >
              Previous
            </Button>
            <span className="text-sm text-text-secondary" data-testid="composer-page-indicator">
              Page {currentPage}
              {numPages ? ` of ${numPages}` : ''}
            </span>
            <Button
              onClick={() => setCurrentPage((p) => Math.min(p + 1, numPages ?? p + 1))}
              disabled={numPages !== null && currentPage === numPages}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
